'use strict';
// node tests/app/test_model.js
const assert = require('assert');
const { view } = require('../../apps/tbw_mdrive/model');
const base = { link: 'up', setup: 0, setupSource: 'state', busy: null, last: null, profile: { m1: true, m2: true, off: true, errors: [] } };
const S = (o) => Object.assign({}, base, o);
const en = (v) => v.buttons.map((b) => b.enabled);

let v = view(false, null);
assert.strictEqual(v.headline, 'Service not running'); assert.deepStrictEqual(en(v), [false, false, false]);
v = view(true, S({}));
assert.strictEqual(v.headline, 'No M setup active'); assert.deepStrictEqual(en(v), [true, true, false]); assert.strictEqual(v.notice, null);
v = view(true, S({ setup: 2 }));
assert.strictEqual(v.headline, 'M2 active'); assert.deepStrictEqual(v.buttons.map((b) => b.active), [false, true, false]);
assert.deepStrictEqual(en(v), [true, false, true], 'the active setup is not asked for again');
// an older car: only "an M setup", no button lit as the active one
v = view(true, S({ setup: 1, setupSource: 'buttons' }));
assert.strictEqual(v.headline, 'M setup active'); assert.deepStrictEqual(v.buttons.map((b) => b.active), [false, false, false]);
// no profile: status live, buttons off, and it says why
v = view(true, S({ setup: 1, profile: { m1: false, m2: false, off: false, errors: [], missing: true } }));
assert.strictEqual(v.headline, 'M1 active'); assert.deepStrictEqual(en(v), [false, false, false]); assert.ok(/Not set up for this car/.test(v.notice.text));
assert.deepStrictEqual(v.buttons.map((b) => b.why), ['not set up', 'not set up', 'not set up']);
// a profile with M1 only
v = view(true, S({ profile: { m1: true, m2: false, off: false, errors: ['m2: method must be 0x0001-0x7fff (a method, not an event)'] } }));
assert.deepStrictEqual(en(v), [true, false, false]); assert.ok(/^Profile: m2/.test(v.notice.text));
// busy: nothing can be pressed
v = view(true, S({ busy: 'm1' }));
assert.deepStrictEqual(en(v), [false, false, false]); assert.ok(/Asking the car for M1/.test(v.notice.text));
// no link: the headline is not a setup, even if an old one is still in the status
v = view(true, S({ link: 'no-hmictl', setup: 1 }));
assert.strictEqual(v.headline, 'Overlays tool missing'); assert.deepStrictEqual(v.buttons.map((b) => b.active || b.enabled), [false, false, false]);
// the last request is shown as the service put it
v = view(true, S({ last: { setup: 'm1', ok: false, code: 'not-confirmed', text: 'sent, but the car did not report M1', at: 1 } }));
assert.deepStrictEqual([v.last.ok, v.last.text], [false, 'M1: sent, but the car did not report M1']);
console.log('model: all ok');
