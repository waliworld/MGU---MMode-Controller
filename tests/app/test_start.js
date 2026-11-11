'use strict';
// The built app started as on an iDrive 8 head unit (kit/tools/mgu8_harness.js: a fake oap-sdk and mgu-render):
// it must ask the renderer to show its page and keep sending frames, with the service running and without it.
//   python3 kit/tools/build.py --hmi ID8 tbw_mdrive && node tests/app/test_start.js
const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..', '..');
for (const s of ['stack-strings', 'stack-objects', 'visible-first']) {
    const env = Object.assign({}, process.env, { TBW_MDRIVE_CTL: '/nonexistent/ctl.sock' });
    const out = cp.execFileSync(process.execPath, [path.join(root, 'kit', 'tools', 'mgu8_harness.js'), path.join(root, 'dist', 'tbw_mdrive'), s], { encoding: 'utf8', timeout: 30000, env: env });
    const r = JSON.parse(out.trim().split('\n').pop());
    assert.strictEqual(r.shows[r.shows.length - 1], 1, s + ': shown\n' + r.log.join('\n'));
    assert.ok(r.frames >= 2, s + ': frames ' + r.frames);
    assert.ok(!r.log.some((l) => /^E /.test(l)), s + ': no errors\n' + r.log.filter((l) => /^E /.test(l)).join('\n'));
    console.log('ok   ' + s + ': shown, ' + r.frames + ' frames, no service: no errors');
}
console.log('start: all ok');
