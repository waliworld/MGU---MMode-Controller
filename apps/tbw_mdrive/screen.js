'use strict';
/*
 * screen.js - the M Setup page, drawn on the kit's recorder (2080 x 520, iDrive 8) from model.js' view.
 *   makeScreen({ theme(), ask(setup), touch() }).draw(cv, view)
 * A button is pressed twice: the first press arms it for 5 s ("tap again to confirm"), the second asks.
 */
const G = require('./kit/gauges');

const W = 2080, H = 520;
const RED = '#e1001a';

function makeScreen(env) {
    function draw(cv, v) {
        const t = env.theme();
        const bottom = G.pageBottom(cv), x0 = 60, colW = 760;
        const tone = v.tone === 'on' ? RED : v.tone === 'warn' ? t.warn : t.dim;
        // left: what the car reports
        cv.text('M SETUP', x0, 96, 20, t.dim, { font: 'bold', spacing: 3 });
        G.stripes(cv, t, x0, 108, 150);
        cv.text(v.headline, x0, 200, 68, v.tone === 'on' ? '#ffffff' : t.text, { font: 'bold', literal: true });
        cv.roundRect(x0, 222, 96, 6, 3, tone);
        wrap(cv, v.detail, x0, 268, colW, 24, t.dim, 32);
        if (v.notice) {
            const c = v.notice.tone === 'warn' ? t.warn : t.dim, y = 350;
            cv.roundRect(x0, y, colW, 104, 14, G.withAlpha(c, 0.12));
            wrap(cv, v.notice.text, x0 + 22, y + 38, colW - 44, 21, c, 28);
        } else if (v.last) {
            const c = v.last.ok ? t.text : t.warn;
            cv.text(v.last.ok ? 'LAST REQUEST' : 'LAST REQUEST FAILED', x0, 372, 16, t.dim, { font: 'bold', spacing: 2 });
            wrap(cv, v.last.text, x0, 406, colW, 22, c, 30);
        }
        // right: the three buttons
        const bx = 900, gap = 28, bw = Math.floor((W - 60 - bx - 2 * gap) / 3), by = 84, bh = Math.min(300, bottom - by - 110);
        v.buttons.forEach((b, i) => bigButton(cv, t, bx + i * (bw + gap), by, bw, bh, b));
        cv.text('Press a button twice to confirm. The car decides: this screen always shows what the car reports.', bx, by + bh + 46, 19, t.dim, { literal: true });
        cv.text('TunedByWali  /  TBW Performance', W - 60, bottom - 8, 16, G.withAlpha('#ffffff', 0.35), { align: 'right', literal: true, spacing: 1 });
        G.frame(cv, t, [], -1);
    }
    // one big button: the setup's name, its state under it. Armed (pressed once) it reads CONFIRM for 5 s.
    const armed = {};
    function bigButton(cv, t, x, y, w, h, b) {
        const live = armed[b.key] && Date.now() - armed[b.key] < 5000 && b.enabled;
        const edge = b.active ? RED : live ? t.warn : b.enabled ? G.withAlpha('#ffffff', 0.35) : G.withAlpha('#ffffff', 0.12);
        cv.card(x, y, w, h, 26, b.active ? [[0, '#3a0008'], [1, '#16070a']] : [[0, t.panelTop], [1, t.panelBottom]]);
        cv.strokeRoundRect(x, y, w, h, 26, b.active || live ? 4 : 2, edge);
        cv.text(b.label.toUpperCase(), x + w / 2, y + h * 0.5, Math.min(110, h * 0.36), b.enabled || b.active ? '#ffffff' : G.withAlpha('#ffffff', 0.3), { align: 'center', font: 'bold', literal: true });
        const sub = live ? 'TAP AGAIN TO CONFIRM' : b.active ? 'ACTIVE' : b.enabled ? (b.key === 'off' ? 'BACK TO NORMAL' : 'ACTIVATE') : String(b.why || '').toUpperCase();
        cv.text(sub, x + w / 2, y + h * 0.5 + 60, 19, live ? t.warn : b.active ? RED : t.dim, { align: 'center', font: 'bold', spacing: 2, literal: true });
        if (!b.enabled) return;
        cv.target(x, y, w, h, () => {
            if (live) { delete armed[b.key]; env.ask(b.key); } else {
                Object.keys(armed).forEach((k) => delete armed[k]);
                armed[b.key] = Date.now();
                setTimeout(env.touch, 5050);
            }
            env.touch();
        }, 'btn-' + b.key, 26);
    }
    function wrap(cv, text, x, y, w, size, c, lh) {
        const words = String(text || '').split(' ');
        let line = '';
        words.forEach((wd) => {
            const next = line ? line + ' ' + wd : wd;
            if (line && cv.textWidth(next, size, { literal: true }) > w) { cv.text(line, x, y, size, c, { literal: true }); y += lh; line = wd; } else line = next;
        });
        if (line) cv.text(line, x, y, size, c, { literal: true });
    }
    return { draw: draw, armed: armed };
}

module.exports = { makeScreen, W, H };
