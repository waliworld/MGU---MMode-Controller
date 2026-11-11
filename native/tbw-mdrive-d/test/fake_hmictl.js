#!/usr/bin/env node
'use strict';
// A stand-in for `hmictl serve`: answers sub / call lines, and plays a car whose MDrive service takes method 30
// (payload 01 = M1, 02 = M2, 00 = off) and reports the setup on 0x8018. FAKE_CAR=deaf: takes the call, reports nothing.
// FAKE_CAR=refuse: answers every call with an error. Every line it gets is appended to FAKE_LOG.
const fs = require('fs');
const rl = require('readline').createInterface({ input: process.stdin });
const car = process.env.FAKE_CAR || 'ok';
rl.on('line', (line) => {
    if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, line + '\n');
    const w = line.split(' ');
    if (w[0] === 'sub') {
        console.log('ok');
        if (w[1] === '0xb51f' && w.indexOf('0x8018') > 0) setTimeout(() => console.log('ev b51f 8018 00'), 20);
        if (w.indexOf('0x8005') > 0) setTimeout(() => { console.log('ev b51f 8005 0a0b'); console.log('ev b51f 8005 0a0c'); }, 20);
    } else if (w[0] === 'call') {
        if (car === 'refuse') return console.log('error service 0xb51f.1 not there');
        console.log('ok');
        if (car === 'ok' && w[1] === '0xb51f' && w[3] === '30') setTimeout(() => console.log('ev b51f 8018 ' + (w[5] || '00')), 50);
    } else console.log('error usage');
});
