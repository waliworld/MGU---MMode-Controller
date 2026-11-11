'use strict';
// Renders the built app's page in software, as the iDrive 8 screen shows it, for each state worth a look.
//   python3 kit/tools/build.py --hmi ID8 tbw_mdrive && node tests/app/preview.js [out dir]
// Also the page's check: every state draws, and only enabled buttons can be tapped.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const js = path.join(__dirname, '..', '..', 'dist', 'tbw_mdrive', 'source', 'javascript');
process.env.MGU_HMI = 'ID8';
const { Recorder } = require(path.join(js, 'kit', 'record'));
const themes = require(path.join(js, 'kit', 'themes'));
const { makeScreen, W, H } = require(path.join(js, 'screen'));
const { view } = require(path.join(js, 'model'));
const { surfaceCanvas } = require('../../kit/tools/surface');

const out = process.argv[2] || path.join(__dirname, '..', '..', 'dist', 'preview');
fs.mkdirSync(out, { recursive: true });
const P = { m1: true, m2: true, off: true, errors: [] }, NONE = { m1: false, m2: false, off: false, errors: [], missing: true };
const base = { link: 'up', setup: 0, setupSource: 'state', busy: null, last: null, profile: P };
const STATES = {
    'm1-active': [true, Object.assign({}, base, { setup: 1 }), null, 2],
    'armed': [true, base, 'm2', 2],
    'not-set-up': [true, Object.assign({}, base, { setup: 1, profile: NONE }), null, 0],
    'not-confirmed': [true, Object.assign({}, base, { last: { setup: 'm1', ok: false, text: 'sent, but the car did not report M1', at: 1 } }), null, 2],
    'no-service': [false, null, null, 0],
};
const place = { x: 0, y: 76, w: 2880, h: 764, full: true, scale: 1.4, ox: -16, oy: 31 };
for (const name of Object.keys(STATES)) {
    const [conn, st, arm, taps] = STATES[name];
    const asked = [];
    const screen = makeScreen({ theme: () => themes.theme(), ask: (k) => asked.push(k), touch: () => {} });
    if (arm) screen.armed[arm] = Date.now();
    const cv = new Recorder(W, H);
    cv.own = true; cv.extra = Math.floor(place.h / place.scale - H - place.oy / place.scale); cv.place = place;
    cv.clear(themes.theme().bg);
    screen.draw(cv, view(conn, st));
    const btn = cv.targets.filter((t) => /^btn-/.test(t.key));
    assert.strictEqual(btn.length, taps, name + ': buttons that can be tapped');
    if (arm) { btn.find((t) => t.key === 'btn-' + arm).run(); assert.deepStrictEqual(asked, [arm], 'the second press asks'); }
    else if (btn.length) { btn[0].run(); assert.deepStrictEqual(asked, [], 'the first press only arms'); }
    fs.writeFileSync(path.join(out, name + '.png'), surfaceCanvas(cv.words(), place, { w: 2880, h: 960 }, path.join(js, 'kit')).png());
    console.log('ok   ' + name);
}
console.log('preview: all ok -> ' + out);
