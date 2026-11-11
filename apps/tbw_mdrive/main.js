'use strict';
/*
 * M Setup (tbw_mdrive) - TunedByWali / TBW Performance. M1 / M2 from the screen, for M cars whose steering wheel
 * buttons are damaged. iDrive 8, drawn through mgu-render (the app kit).
 *
 * One page: what the car reports (none / M1 / M2), and three buttons. A button asks the service (tbw-mdrive-d, a
 * root tool: mdrived.js) over its control socket; the service sends this car's command and waits for the car to
 * report the setup. Each button is pressed twice (the second within 5 s: "Confirm"), as the wheel's own double
 * press for a setup with DSC off. Nothing here talks to the car itself.
 */
const net = require('net');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { view } = require('./model');
const { makeScreen, W, H } = require('./screen');

const CTL = process.env.TBW_MDRIVE_CTL || '/run/tbw-mdrive/ctl.sock';

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        let sock = null, conn = false, status = null, dirty = true, buf = '', seq = 0;
        const touch = () => { dirty = true; };

        function connect() {
            const s = net.connect(CTL);
            sock = s; buf = '';
            s.on('connect', () => { conn = true; log.info('service connected'); touch(); });
            s.on('data', (d) => {
                buf += d;
                for (let n = buf.indexOf('\n'); n >= 0; n = buf.indexOf('\n')) {
                    let m = null;
                    try { m = JSON.parse(buf.slice(0, n)); } catch (e) { /* not ours */ }
                    buf = buf.slice(n + 1);
                    if (m && m.type === 'status') { status = m.status; touch(); }
                }
            });
            s.on('error', () => {});
            s.on('close', () => {
                if (sock !== s) return;
                if (conn) log.warn('service connection lost');
                conn = false; status = null; sock = null; touch();
                setTimeout(connect, 2000);
            });
        }
        const ask = (setup) => {
            if (!sock || !conn) return;
            log.info('asked for ' + setup);
            try { sock.write(JSON.stringify({ op: 'activate', setup: setup, id: ++seq }) + '\n'); } catch (e) { log.warn('service write: ' + e.message); }
        };
        connect();
        G.onConfirm(touch);
        if (ctx.onLayout) ctx.onLayout(touch);

        const screen = makeScreen({ theme: () => ctx.theme(), ask: ask, touch: touch });
        const draw = (cv) => screen.draw(cv, view(conn, status));

        let last = null, lastT = 0;
        ctx.loop('VIEW', 10, () => {
            const now = Date.now();
            // drawn on a change and once a second (the renderer hides an app that says nothing for 3 s)
            if (!last || dirty || now - lastT > 1000) {
                dirty = false; lastT = now;
                last = ctx.canvas(W, H).clear(ctx.theme().bg);
                draw(last);
            }
            return ui.image('VIEW_GFX', last);
        });
        log.info('M Setup started');
    },
});
