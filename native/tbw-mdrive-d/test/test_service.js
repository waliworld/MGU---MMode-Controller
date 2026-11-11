'use strict';
// The service against a stand-in hmictl (fake_hmictl.js): status, activation confirmed by the car, not confirmed,
// refused, not set up, and discovery.   node test/test_service.js
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const PROFILE = { version: 1, note: 'test car', commands: {
    m1: [{ svc: '0xb51f', method: 30, hex: '01' }], off: [{ svc: '0xb51f', method: 30, hex: '00', waitMs: 10 }] } };

function run(car, profile, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbwm-'));
    if (profile) fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(profile));
    const env = Object.assign({}, process.env, { TBW_MDRIVE_DATA: dir, TBW_MDRIVE_CTL: path.join(dir, 'ctl.sock'),
        TBW_HMICTL: path.join(__dirname, 'fake_hmictl.js'), FAKE_CAR: car, FAKE_LOG: path.join(dir, 'hmictl.log') });
    const d = cp.spawn(process.execPath, [path.join(__dirname, '..', 'mdrived.js')], { env: env, stdio: 'ignore' });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const client = () => new Promise((res, rej) => {
        const c = net.connect(env.TBW_MDRIVE_CTL), api = { status: null, results: {} };
        let buf = '', n = 0;
        c.on('error', rej);
        c.on('connect', () => res(api));
        c.on('data', (x) => {
            buf += x;
            for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
                const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
                if (m.type === 'status') api.status = m.status; else if (api.results[m.id]) api.results[m.id](m);
            }
        });
        api.ask = (req) => new Promise((r) => { const id = ++n; api.results[id] = r; c.write(JSON.stringify(Object.assign({ id: id }, req)) + '\n'); });
        api.raw = (s) => c.write(s);
        api.close = () => c.destroy();
    });
    return wait(400).then(client).then((c) => wait(300).then(() => fn(c, { dir: dir, wait: wait, sent: () => fs.readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n') }))
        .then(() => c.close())).then(() => d.kill(), (e) => { d.kill(); throw e; });
}

(async () => {
    await run('ok', PROFILE, async (c, t) => {
        assert.strictEqual(c.status.link, 'up');
        assert.strictEqual(c.status.setup, 0, 'the car reports no M setup');
        assert.deepStrictEqual([c.status.profile.m1, c.status.profile.m2, c.status.profile.off], [true, false, true]);
        const r = await c.ask({ op: 'activate', setup: 'm1' });
        assert.deepStrictEqual([r.ok, r.confirmed], [true, true], JSON.stringify(r));
        assert.strictEqual(c.status.setup, 1);
        assert.ok(t.sent().indexOf('call 0xb51f 1 30 1 01') >= 0);
        const m2 = await c.ask({ op: 'activate', setup: 'm2' });
        assert.strictEqual(m2.code, 'not-set-up');
        const before = t.sent().length;
        // nothing an app sends becomes a line for hmictl
        for (const bad of [{ op: 'activate', setup: 'm1\ncall 0x1 1 1 1' }, { op: 'call', line: 'call 0xb51f 1 1 1' }, { op: 'activate' }]) assert.strictEqual((await c.ask(bad)).ok, false);
        c.raw('not json\n');
        assert.strictEqual(t.sent().length, before, 'nothing went to the car');
        const off = await c.ask({ op: 'activate', setup: 'off' });
        assert.strictEqual(off.ok, true);
        assert.strictEqual(c.status.setup, 0);
        assert.strictEqual(c.status.last.setup, 'off');
        // discovery: the wider subscription, changes recorded
        await c.ask({ op: 'discovery', on: true });
        await t.wait(200);
        const ev = (await c.ask({ op: 'events' })).events;
        assert.ok(ev.some((l) => /0x8005 0a0b -> 0a0c/.test(l)), JSON.stringify(ev));
        assert.ok(/0x8005/.test(fs.readFileSync(path.join(t.dir, 'events.log'), 'utf8')));
        console.log('ok   activation confirmed by the car, input checks, discovery');
    });
    await run('deaf', PROFILE, async (c) => {
        const r = await c.ask({ op: 'activate', setup: 'm1' });
        assert.deepStrictEqual([r.ok, r.code], [false, 'not-confirmed']);
        assert.strictEqual(c.status.setup, 0, 'still what the car reports, not what was asked');
        console.log('ok   sent but not confirmed: said so');
    });
    await run('refuse', PROFILE, async (c) => {
        const r = await c.ask({ op: 'activate', setup: 'm1' });
        assert.strictEqual(r.code, 'refused');
        console.log('ok   refused by the car: said so');
    });
    await run('ok', null, async (c, t) => {
        assert.strictEqual(c.status.profile.missing, true);
        assert.strictEqual((await c.ask({ op: 'activate', setup: 'm1' })).code, 'not-set-up');
        assert.ok(!t.sent().some((l) => /^call/.test(l)));
        console.log('ok   no profile: nothing sent');
    });
    console.log('service: all ok');
})().catch((e) => { console.error(e); process.exit(1); });
