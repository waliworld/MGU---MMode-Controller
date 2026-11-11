'use strict';
/*
 * mdrived.js - tbw-mdrive-d: the root service behind the TBW "M Setup" app (iDrive 8, Node 8).
 * TunedByWali / TBW Performance (Built by Wali LLC). MIT.
 *
 * What it does
 *   - reads the M setup the car reports (none / M1 / M2) from the head unit's MDrive SOME/IP service
 *   - on the app's request, sends this car's activation command for M1, M2 or off, then waits for the car to report
 *     the setup and says whether it did
 *   - optional discovery mode: records every MDrive notification (what changed, when) to find a car's commands
 *
 * How it talks to the car
 *   The head unit has no CAN bus of its own to write to: the car's buses end at the gateway, and the head unit speaks
 *   SOME/IP to it over Ethernet. So a request goes out as a SOME/IP call, through `hmictl serve` (a vsomeip client;
 *   one line out, one line back, "ev" lines are notifications). hmictl is IterioDev's and is NOT part of this tool:
 *   it is used where the Overlays or Comfort tool installed it (HMICTL_PATHS).
 *
 * The activation command is per car and is NOT built in: nobody has published one, and a wrong SOME/IP call must
 * not go to a car's drive-dynamics service on a guess. It is read from PROFILE (root-owned, written over SSH):
 *   { "version": 1, "note": "G82 2023, found 2026-..", "commands": {
 *       "m1":  [ { "svc": "0xb51f", "inst": 1, "method": 0, "major": 1, "hex": "" } ],
 *       "m2":  [ ... ], "off": [ ... ] } }
 *   Each entry is a list of calls sent in order ("waitMs": a pause after one, at most 2000). Without an entry for a
 *   setup the app shows it as not set up, and nothing is sent. README.md, "Finding the command".
 *
 * The apps' control socket CTL (0666, JSON lines) only takes: status, activate (a setup the profile has), discovery
 * on / off, events. It never takes a raw call: any app on the head unit can open it.
 *
 *   node mdrived.js            the service
 *   node mdrived.js --test     the self-check (no car needed)
 *   node mdrived.js status     what the running service says (over CTL), for SSH
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const DATA_DIR = process.env.TBW_MDRIVE_DATA || '/var/opt/tbw-mdrive';
const PROFILE = path.join(DATA_DIR, 'profile.json');
const EVENTS = path.join(DATA_DIR, 'events.log');
const CTL = process.env.TBW_MDRIVE_CTL || '/run/tbw-mdrive/ctl.sock';
const HMICTL_PATHS = (process.env.TBW_HMICTL ? [process.env.TBW_HMICTL] : [])
    .concat(['/var/opt/iteriodev-overlays/current/hmictl', '/var/opt/iteriodev-comfort/current/hmictl']);
const VERSION = '0.1.0';

// The head unit's MDrive service and what it notifies (ids as the iDrive 8 HMI uses them; seen on G8x cars):
//   0x8018 statusMConfigurationMDrive, byte 0: 0 no M setup, 1 M1, 2 M2, 3 not filled in. A state.
//   0x8001 statusMDriveTwo (older cars), byte 0: 1 = a configuration is being applied, byte 1: 1 = by the M buttons.
//          Not a state: one such frame per button action, so it toggles between "an M setup" and none.
const MDRIVE = 0xb51f;
const EV_SETUP = 0x8018, EV_LEGACY = 0x8001;
const SUB_CORE = 'sub 0xb51f 1 1 1 0x8018 0x8001';
// discovery: the rest of the service's first 48 notifications, on the same event group
const SUB_WIDE = 'sub 0xb51f 1 1 1 ' + range(0x8002, 0x8030).filter((e) => e !== EV_SETUP).map((e) => '0x' + e.toString(16)).join(' ');
// the car switched off ends an M setup: VehicleCondition 0x1531, event 0x8002, byte 5 (1, 2 parked; 3, 5 standing
// functions / residing; 10 driving)
const VCOND = 0x1531, EV_VCOND = 0x8002, SUB_VCOND = 'sub 0x1531 1 1 2 0x8002';

const CONFIRM_MS = 4000;        // how long the car has to report the setup after a command
const LEGACY_PULSE_MS = 1000;   // 0x8001 frames closer than this are one button action
const SETUPS = { m1: 1, m2: 2, off: 0 };
const NAMES = ['off', 'm1', 'm2'];

function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }
const log = (m) => console.log(m);

/* ---------------- the profile (pure; --test) ---------------- */

const isInt = (v, lo, hi) => typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= lo && v <= hi;
function num(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^(0x[0-9a-fA-F]{1,4}|\d{1,5})$/.test(v)) return parseInt(v, v.slice(0, 2) === '0x' ? 16 : 10);
    return NaN;
}
/** one call of a profile -> { line (for hmictl), waitMs } or throws why not */
function callOf(c) {
    if (!c || typeof c !== 'object') throw new Error('a call must be an object');
    const svc = num(c.svc), inst = num(c.inst === undefined ? 1 : c.inst), method = num(c.method), major = num(c.major === undefined ? 1 : c.major);
    if (!isInt(svc, 1, 0xfffe)) throw new Error('svc must be 0x0001-0xfffe');
    if (!isInt(inst, 1, 0xfffe)) throw new Error('inst must be 1-0xfffe');
    if (!isInt(method, 1, 0x7fff)) throw new Error('method must be 0x0001-0x7fff (a method, not an event)');
    if (!isInt(major, 0, 255)) throw new Error('major must be 0-255');
    const hex = c.hex === undefined ? '' : c.hex;
    if (typeof hex !== 'string' || !/^([0-9a-fA-F]{2}){0,64}$/.test(hex)) throw new Error('hex must be at most 64 bytes of hex');
    const waitMs = c.waitMs === undefined ? 0 : c.waitMs;
    if (!isInt(waitMs, 0, 2000)) throw new Error('waitMs must be 0-2000');
    return { line: ('call 0x' + svc.toString(16) + ' ' + inst + ' ' + method + ' ' + major + ' ' + hex.toLowerCase()).trim(), waitMs: waitMs };
}
/** profile JSON text -> { commands: { m1?, m2?, off?: [{line, waitMs}] }, note, errors: [] }. Bad entries are left out. */
function parseProfile(text) {
    const out = { commands: {}, note: '', errors: [] };
    let p;
    try { p = JSON.parse(text); } catch (e) { out.errors.push('profile.json is not JSON: ' + e.message); return out; }
    if (!p || typeof p !== 'object' || p.version !== 1) { out.errors.push('profile.json: "version": 1 expected'); return out; }
    if (typeof p.note === 'string') out.note = p.note.slice(0, 120);
    const cmds = p.commands && typeof p.commands === 'object' ? p.commands : {};
    Object.keys(SETUPS).forEach((k) => {
        if (cmds[k] === undefined) return;
        try {
            if (!Array.isArray(cmds[k]) || !cmds[k].length || cmds[k].length > 8) throw new Error('a list of 1-8 calls expected');
            out.commands[k] = cmds[k].map(callOf);
        } catch (e) { out.errors.push(k + ': ' + e.message); }
    });
    return out;
}
function loadProfile(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { commands: {}, note: '', errors: [], missing: true }; }
    // the profile decides what is sent to the car: only root may be able to write it
    try {
        const st = fs.statSync(file);
        if (st.uid !== 0 && !process.env.TBW_MDRIVE_DATA) return { commands: {}, note: '', errors: ['profile.json is not owned by root: ignored'] };
        if ((st.mode & 0o022) && !process.env.TBW_MDRIVE_DATA) return { commands: {}, note: '', errors: ['profile.json is writable by others: ignored (chmod 600)'] };
    } catch (e) { /* read above */ }
    return parseProfile(text);
}

/* ---------------- the M setup the car reports (pure; --test) ---------------- */

/** a notification -> the setup now (0, 1, 2) or null: not about it. m: { state: bool (0x8018 seen), legacy: 0|1, pulseAt } */
function setupOf(m, ev, hex, now) {
    const b0 = parseInt((hex || '').slice(0, 2), 16);
    if (ev === EV_SETUP) {
        if (!(b0 >= 0 && b0 <= 2)) return null;          // 3: not filled in
        m.state = true;
        return b0;
    }
    if (ev !== EV_LEGACY || m.state) return null;        // the state wins once the car has sent it
    if (b0 !== 1 || parseInt((hex || '').slice(2, 4), 16) !== 1) return null;   // not applied by the M buttons
    if (m.pulseAt !== undefined && now - m.pulseAt < LEGACY_PULSE_MS) return null;
    m.pulseAt = now;
    m.legacy = m.legacy ? 0 : 1;
    return m.legacy;                                      // 1 = an M setup (which of the two the car doesn't say)
}
const carOff = (hex) => [1, 2, 3, 5].indexOf(parseInt((hex || '').slice(10, 12), 16)) >= 0;

/* ---------------- the service ---------------- */

function findHmictl() {
    for (let i = 0; i < HMICTL_PATHS.length; i++) {
        try { fs.accessSync(HMICTL_PATHS[i], fs.constants.X_OK); return HMICTL_PATHS[i]; } catch (e) { /* next */ }
    }
    return null;
}

function service() {
    const m = { state: false, legacy: 0 };
    const st = {
        version: VERSION, link: 'starting', linkDetail: '', setup: null, setupSource: null, setupAt: 0,
        profile: { m1: false, m2: false, off: false, note: '', errors: [], missing: true }, discovery: false, busy: null, last: null,
    };
    let profile = { commands: {}, note: '', errors: [], missing: true };
    const clients = [];
    const waiters = [];              // activations waiting for the car's report: { want, done }
    const lastHex = {};              // discovery: event -> its last payload
    const recent = [];               // discovery: the last 60 changes, for the app

    const publicState = () => JSON.stringify({ type: 'status', status: st }) + '\n';
    function push() { const s = publicState(); clients.forEach((c) => { try { c.write(s); } catch (e) { /* gone */ } }); }

    function reloadProfile() {
        profile = loadProfile(PROFILE);
        st.profile = { m1: !!profile.commands.m1, m2: !!profile.commands.m2, off: !!profile.commands.off,
            note: profile.note, errors: profile.errors, missing: !!profile.missing };
        log('profile: ' + (profile.missing ? 'none (' + PROFILE + ')' : NAMES.filter((k) => profile.commands[k]).join(', ') || 'no commands')
            + (profile.errors.length ? ' - ' + profile.errors.join('; ') : ''));
    }

    /* hmictl serve: one line out, one line back, in order */
    let child = null, out = '', busy = null, busyTimer = null, hmictl = null, retry = null;
    const queue = [];
    function hmi(line) { return new Promise((res) => { queue.push({ line: line, res: res }); pump(); }); }
    function setLink(link, detail) {
        if (st.link === link && st.linkDetail === (detail || '')) return;
        st.link = link; st.linkDetail = detail || '';
        log('link: ' + link + (detail ? ' (' + detail + ')' : ''));
        push();
    }
    function start() {
        retry = null;
        hmictl = findHmictl();
        if (!hmictl) {
            setLink('no-hmictl', 'install the Overlays or Comfort tool from IterioDev/car-apps');
            retry = setTimeout(start, 30000);
            return;
        }
        subscribe();
    }
    function pump() {
        if (busy || !queue.length) return;
        if (!hmictl) { const q = queue.shift(); q.res('error no hmictl'); return pump(); }
        if (!child) {
            child = spawn(hmictl, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
            child.on('error', (e) => log('hmictl: ' + e.message));
            child.stdin.on('error', (e) => log('hmictl: ' + e.message));
            child.stdout.on('data', (d) => {
                out += d;
                for (let n = out.indexOf('\n'); n >= 0; n = out.indexOf('\n')) {
                    const line = out.slice(0, n);
                    out = out.slice(n + 1);
                    if (line.slice(0, 3) === 'ev ') onEvent(line); else if (/^(ok|error)\b/.test(line)) done(line);
                }
            });
            child.on('exit', (c) => {
                log('hmictl exited ' + c);
                child = null; out = '';
                if (busy) done('error hmictl exited');
                setLink('down', 'hmictl exited');
                if (!retry) retry = setTimeout(start, 3000);     // a new hmictl has no subscriptions
            });
        }
        busy = queue.shift();
        busyTimer = setTimeout(() => { if (child) child.kill(); }, 10000);
        try { child.stdin.write(busy.line + '\n'); } catch (e) { done('error ' + e.message); }
    }
    function done(line) {
        clearTimeout(busyTimer);
        const b = busy; busy = null;
        if (b) b.res(line);
        pump();
    }
    function subscribe() {
        hmi(SUB_CORE).then((r) => {
            if (/^ok\b/.test(r)) setLink('up'); else setLink('no-service', r.replace(/^error\s*/, ''));
            if (!/^ok\b/.test(r) && !retry) retry = setTimeout(start, 15000);    // the car may still be starting
            return hmi(SUB_VCOND);
        }).then(() => (st.discovery ? hmi(SUB_WIDE) : null)).then((r) => { if (r && !/^ok\b/.test(r)) log('discovery: ' + r); });
    }

    function setSetup(v, source) {
        if (st.setup !== v || st.setupSource !== source) log('M setup: ' + (v === null ? 'unknown' : NAMES[v]) + ' (' + source + ')');
        st.setup = v; st.setupSource = source; st.setupAt = Date.now();
        for (let i = waiters.length - 1; i >= 0; i--) {
            // an older car says only "an M setup" / none: that confirms M1 and M2 alike
            const w = waiters[i], hit = source === 'state' ? w.want === v : (w.want === 0) === (v === 0);
            if (hit) { waiters.splice(i, 1); w.done(true); }
        }
        push();
    }
    function record(ev, hex) {
        const key = ev.toString(16);
        if (lastHex[key] === hex) return;
        const line = new Date().toISOString() + ' 0x' + key + ' ' + (lastHex[key] === undefined ? '(first)' : lastHex[key]) + ' -> ' + hex;
        lastHex[key] = hex;
        recent.push(line);
        if (recent.length > 60) recent.shift();
        try {
            let size = 0;
            try { size = fs.statSync(EVENTS).size; } catch (e) { /* new */ }
            if (size > 512 * 1024) fs.renameSync(EVENTS, EVENTS + '.1');
            fs.appendFileSync(EVENTS, line + '\n');
        } catch (e) { /* the log is best effort */ }
    }
    function onEvent(line) {
        const w = line.split(' '), svc = parseInt(w[1], 16), ev = parseInt(w[2], 16), hex = w[3] || '';
        if (svc === MDRIVE) {
            if (st.discovery) record(ev, hex);
            const s = setupOf(m, ev, hex, Date.now());
            if (s !== null) setSetup(s, m.state ? 'state' : 'buttons');
        } else if (svc === VCOND && ev === EV_VCOND && carOff(hex) && !m.state && m.legacy) {
            m.legacy = 0;
            setSetup(0, 'car off');
        }
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    /** send the profile's calls for a setup, then wait for the car to report it */
    function activate(name) {
        const want = SETUPS[name];
        if (want === undefined) return Promise.resolve({ ok: false, code: 'bad-setup', text: 'unknown setup' });
        const calls = profile.commands[name];
        if (!calls) return Promise.resolve({ ok: false, code: 'not-set-up', text: 'no command for ' + name.toUpperCase() + ' in this car\'s profile' });
        if (st.link !== 'up') return Promise.resolve({ ok: false, code: 'no-link', text: 'no link to the car (' + st.link + ')' });
        if (st.busy) return Promise.resolve({ ok: false, code: 'busy', text: 'another request is running' });
        st.busy = name; push();
        let chain = Promise.resolve(null);
        calls.forEach((c) => {
            chain = chain.then((err) => (err ? err : hmi(c.line).then((r) => {
                log('activate ' + name + ': ' + c.line + ' -> ' + r);
                if (!/^ok\b/.test(r)) return r.replace(/^error\s*/, '') || 'refused';
                return c.waitMs ? sleep(c.waitMs).then(() => null) : null;
            })));
        });
        return chain.then((err) => {
            if (err) return { ok: false, code: 'refused', text: 'the car refused the command: ' + err };
            if (st.setup === want && st.setupSource === 'state') return { ok: true, confirmed: true, text: name.toUpperCase() + ' is on' };
            return new Promise((res) => {
                const w = { want: want, done: (hit) => { clearTimeout(t); res(hit); } };
                const t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); res(false); }, CONFIRM_MS);
                waiters.push(w);
            }).then((hit) => (hit
                ? { ok: true, confirmed: true, text: name === 'off' ? 'M setup is off' : name.toUpperCase() + ' is on' }
                : { ok: false, code: 'not-confirmed', text: 'sent, but the car did not report ' + (name === 'off' ? 'the M setup off' : name.toUpperCase()) }));
        }).then((r) => { st.busy = null; st.last = { setup: name, at: Date.now(), ok: r.ok, code: r.code || null, text: r.text }; push(); return r; });
    }

    function onRequest(c, req) {
        const reply = (o) => { try { c.write(JSON.stringify(Object.assign({ type: 'result', id: req.id === undefined ? null : req.id }, o)) + '\n'); } catch (e) { /* gone */ } };
        if (!req || typeof req !== 'object') return;
        if (req.op === 'status') c.write(publicState());
        else if (req.op === 'activate') activate(String(req.setup)).then(reply);
        else if (req.op === 'reload') { reloadProfile(); push(); reply({ ok: true }); }
        else if (req.op === 'discovery') {
            st.discovery = !!req.on;
            log('discovery ' + (st.discovery ? 'on' : 'off'));
            if (st.discovery && st.link === 'up') hmi(SUB_WIDE).then((r) => { if (!/^ok\b/.test(r)) log('discovery: ' + r); });
            push(); reply({ ok: true });
        } else if (req.op === 'events') reply({ ok: true, events: recent.slice() });
        else reply({ ok: false, code: 'bad-op', text: 'unknown request' });
    }

    try { fs.mkdirSync(DATA_DIR); } catch (e) { if (e.code !== 'EEXIST') log('data dir: ' + e.message); }
    reloadProfile();
    try { fs.watchFile(PROFILE, { interval: 5000 }, () => { reloadProfile(); push(); }); } catch (e) { /* reload by request */ }
    try { fs.unlinkSync(CTL); } catch (e) { /* none */ }
    const srv = net.createServer((c) => {
        let buf = '';
        clients.push(c);
        c.on('error', () => {});
        c.on('close', () => { const i = clients.indexOf(c); if (i >= 0) clients.splice(i, 1); });
        c.on('data', (d) => {
            buf += d;
            if (buf.length > 65536) { c.destroy(); return; }
            for (let n = buf.indexOf('\n'); n >= 0; n = buf.indexOf('\n')) {
                const line = buf.slice(0, n);
                buf = buf.slice(n + 1);
                let req = null;
                try { req = JSON.parse(line); } catch (e) { /* not ours */ }
                onRequest(c, req);
            }
        });
        c.write(publicState());
    });
    srv.listen(CTL, () => { try { fs.chmodSync(CTL, 0o666); } catch (e) { log('control socket: ' + e.message); } });
    log('tbw-mdrive-d ' + VERSION + ', control socket ' + CTL);
    start();
    const stop = () => { try { if (child) child.kill(); } catch (e) { /* gone */ } try { fs.unlinkSync(CTL); } catch (e) { /* gone */ } process.exit(0); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

/* ---------------- status over SSH ---------------- */
function cli(op) {
    const c = net.connect(CTL);
    let buf = '';
    c.on('error', (e) => { console.error('tbw-mdrive-d is not running: ' + e.message); process.exit(1); });
    c.on('data', (d) => {
        buf += d;
        const n = buf.indexOf('\n');
        if (n < 0) return;
        const s = JSON.parse(buf.slice(0, n)).status;
        if (op === 'reload') c.write(JSON.stringify({ op: 'reload' }) + '\n');
        console.log(JSON.stringify(s, null, 2));
        setTimeout(() => process.exit(0), op === 'reload' ? 300 : 0);
    });
}

/* ---------------- self-check ---------------- */
function test() {
    const assert = require('assert');
    // a call line as hmictl takes it
    assert.deepStrictEqual(callOf({ svc: '0xb51f', inst: 1, method: 30, major: 1, hex: '01FF' }), { line: 'call 0xb51f 1 30 1 01ff', waitMs: 0 });
    assert.deepStrictEqual(callOf({ svc: 0xb51f, method: '0x1e', waitMs: 250 }), { line: 'call 0xb51f 1 30 1', waitMs: 250 });
    // nothing but numbers and hex can reach hmictl's line
    [{ svc: '0xb51f; rm', method: 1 }, { svc: '0xb51f', method: 0x8001 }, { svc: '0xb51f', method: 1, hex: '0g' }, { svc: '0xb51f', method: 1, hex: '012' },
        { svc: '0xb51f', method: 1, hex: '01\ncall 0x1 1 1 1' }, { svc: '0xb51f', method: 1, waitMs: 60000 }, { svc: 0, method: 1 }, { svc: '0xb51f', method: 1.5 },
        { svc: '0xb51f', method: 1, inst: '1 2' }, null, 'call'].forEach((c) => assert.throws(() => callOf(c), undefined, JSON.stringify(c)));
    // profiles: a good entry is kept beside a bad one, and says why
    const p = parseProfile(JSON.stringify({ version: 1, note: 'G82', commands: {
        m1: [{ svc: '0xb51f', method: 30, hex: '01' }], m2: [{ svc: '0xb51f', method: 0 }], off: [], track: [{ svc: '0xb51f', method: 1 }] } }));
    assert.deepStrictEqual(Object.keys(p.commands), ['m1']);
    assert.strictEqual(p.errors.length, 2);
    assert.strictEqual(p.note, 'G82');
    assert.deepStrictEqual(parseProfile('{').commands, {});
    assert.deepStrictEqual(parseProfile('{"version":2,"commands":{"m1":[{"svc":"0xb51f","method":1}]}}').commands, {});
    // the car's state: 0 none, 1 M1, 2 M2; 3 and other events are not about it
    const s = { state: false, legacy: 0 };
    assert.deepStrictEqual([setupOf(s, 0x8018, '0201', 0), setupOf(s, 0x8018, '00', 1), setupOf(s, 0x8018, '03', 2), setupOf(s, 0x8005, '01', 3), setupOf(s, 0x8018, '01', 4)],
        [2, 0, null, null, 1]);
    assert.strictEqual(setupOf(s, 0x8001, '0101', 9000), null, 'the state wins over the button frames');
    // older cars: one button frame toggles, repeats within a second and frames the car sends by itself don't
    const l = { state: false, legacy: 0 };
    assert.deepStrictEqual([setupOf(l, 0x8001, '0000', 0), setupOf(l, 0x8001, '0100', 5000), setupOf(l, 0x8001, '0101', 15000), setupOf(l, 0x8001, '0101', 15500),
        setupOf(l, 0x8001, '0101', 27000)], [null, null, 1, null, 0]);
    assert.deepStrictEqual(['00000000000502', '00000000000a02', ''].map(carOff), [true, false, false]);
    // the discovery subscription leaves out what the core one has
    assert.ok(SUB_WIDE.indexOf('0x8018') < 0 && SUB_WIDE.indexOf('0x8002') > 0 && SUB_WIDE.indexOf('0x8030') > 0);
    console.log('mdrived: all ok');
}

if (require.main === module) {
    const a = process.argv[2];
    if (a === '--test') test();
    else if (a === 'status' || a === 'reload') cli(a);
    else service();
}
module.exports = { callOf, parseProfile, setupOf, carOff, SUB_CORE, SUB_WIDE };
