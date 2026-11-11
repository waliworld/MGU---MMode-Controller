'use strict';
/*
 * model.js - what the M Setup screen says, from what the service reports (pure: tested in test/test_model.js).
 *   view(conn, status) -> { headline, detail, tone, buttons: [{ key, label, enabled, active, why }], notice, last }
 * conn: the app has the service's socket; status: the service's status (mdrived.js) or null.
 * The headline is always what the car reports, never what was asked for.
 */
const LINK = {
    starting: ['Connecting to the car', 'The service is starting.'],
    'no-hmictl': ['Overlays tool missing', 'Install the Overlays tool from IterioDev/car-apps in the Store, then restart the head unit.'],
    'no-service': ['The car has no M Drive service', 'This head unit does not offer the M setup (not an M car, or the car is still starting).'],
    down: ['Link to the car lost', 'Reconnecting.'],
};
const LABEL = { m1: 'M1', m2: 'M2', off: 'Off' };

function view(conn, st) {
    const off = (why) => ['m1', 'm2', 'off'].map((k) => ({ key: k, label: LABEL[k], enabled: false, active: false, why: why }));
    if (!conn || !st) {
        return { headline: 'Service not running', detail: 'Install the M Setup service (tbw-mdrive-d) in the Store and restart the head unit.',
            tone: 'warn', buttons: off('no service'), notice: null, last: null };
    }
    const v = { tone: 'dim', notice: null, last: null };
    if (st.link !== 'up') {
        const l = LINK[st.link] || ['No link to the car', String(st.link)];
        v.headline = l[0]; v.detail = l[1] + (st.linkDetail && st.link === 'no-service' ? ' (' + st.linkDetail + ')' : ''); v.tone = 'warn';
    } else if (st.setup === null || st.setup === undefined) {
        v.headline = 'Waiting for the car'; v.detail = 'The car has not reported its M setup yet.';
    } else if (st.setup === 0) {
        v.headline = 'No M setup active'; v.detail = 'The car is in its normal configuration.';
    } else if (st.setupSource === 'state') {
        v.headline = 'M' + st.setup + ' active'; v.detail = 'Reported by the car.'; v.tone = 'on';
    } else {
        // older cars report only that an M setup was switched on, not which one
        v.headline = 'M setup active'; v.detail = 'This car does not report which one (M1 or M2).'; v.tone = 'on';
    }
    const p = st.profile || {};
    const exact = st.setupSource === 'state';
    v.buttons = ['m1', 'm2', 'off'].map((k) => {
        const want = k === 'off' ? 0 : k === 'm1' ? 1 : 2;
        const b = { key: k, label: LABEL[k], enabled: false, active: st.link === 'up' && exact && st.setup === want && want !== 0, why: null };
        if (st.link !== 'up') b.why = 'no link';
        else if (!p[k]) b.why = 'not set up';
        else if (st.busy) b.why = 'busy';
        // what the car already reports is not asked for again (on the wheel a second press of the same button leaves the setup)
        else if (exact && st.setup === want) b.why = want ? 'active' : 'already off';
        else b.enabled = true;
        return b;
    });
    if (st.busy) v.notice = { tone: 'dim', text: 'Asking the car for ' + (st.busy === 'off' ? 'the M setup off' : LABEL[st.busy]) + ' ...' };
    else if (!p.m1 && !p.m2 && !p.off) {
        v.notice = { tone: 'warn', text: 'Not set up for this car yet: its profile has no activation command, so the buttons are off. The status above is live.' };
    } else if (p.errors && p.errors.length) v.notice = { tone: 'warn', text: 'Profile: ' + p.errors[0] };
    if (st.last && !st.busy) v.last = { ok: !!st.last.ok, text: (LABEL[st.last.setup] || '') + ': ' + st.last.text, at: st.last.at };
    return v;
}

module.exports = { view, LABEL };
