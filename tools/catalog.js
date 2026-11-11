'use strict';
// Lays out the MGU Store catalog of this repository in dist/release/: catalog.json, the app's OAP package (without
// node_modules/oap-sdk: the head unit makes BMW's SDK module from an app already on the car), the service's tool kit
// and the app icon. Upload every file of dist/release/ to the GitHub release tagged `catalog`.
//   node tools/catalog.js <owner/repo> <app.tgz> <tool.tgz>
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [repo, appTgz, toolTgz] = process.argv.slice(2);
if (!repo || !appTgz || !toolTgz) { console.error('usage: node tools/catalog.js <owner/repo> <app.tgz> <tool.tgz>'); process.exit(1); }
const root = path.join(__dirname, '..'), out = path.join(root, 'dist', 'release');
const app = JSON.parse(fs.readFileSync(path.join(root, 'apps', 'tbw_mdrive', 'app.json'), 'utf8'));
const tool = JSON.parse(fs.readFileSync(path.join(root, 'native', 'tbw-mdrive-d', 'component.json'), 'utf8'));
const MTIME = Number(process.env.SOURCE_DATE_EPOCH || 0);

/** a tar.gz again without the members under `drop`, one mtime, owner 0:0 (ustar, as npm pack writes it) */
function stripTar(src, drop) {
    const tar = zlib.gunzipSync(fs.readFileSync(src)), keep = [];
    for (let o = 0; o + 512 <= tar.length;) {
        const h = tar.slice(o, o + 512);
        if (h.every((b) => b === 0)) break;
        const name = (h.toString('utf8', 345, 500).replace(/\0.*$/, '') ? h.toString('utf8', 345, 500).replace(/\0.*$/, '') + '/' : '') + h.toString('utf8', 0, 100).replace(/\0.*$/, '');
        const size = parseInt(h.toString('ascii', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
        const len = 512 + Math.ceil(size / 512) * 512;
        if (name.indexOf(drop) < 0) {
            const m = Buffer.from(tar.slice(o, o + len));
            m.write(('0000000' + (0).toString(8)).slice(-7) + '\0', 108, 'ascii'); m.write('0000000\0', 116, 'ascii');
            m.write(('00000000000' + MTIME.toString(8)).slice(-11) + '\0', 136, 'ascii');
            m.fill(0, 265, 329);                                  // uname, gname
            m.fill(' ', 148, 156);
            let sum = 0; for (let i = 0; i < 512; i++) sum += m[i];
            m.write(('000000' + sum.toString(8)).slice(-6) + '\0 ', 148, 'ascii');
            keep.push({ name: name, m: m });
        }
        o += len;
    }
    keep.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const gz = zlib.gzipSync(Buffer.concat(keep.map((k) => k.m).concat([Buffer.alloc(1024)])), { level: 9 });
    gz.writeUInt32LE(MTIME, 4); gz[9] = 3;                        // gzip header: mtime, OS Unix
    return { gz: gz, names: keep.map((k) => k.name) };
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const base = 'https://github.com/' + repo + '/releases/download/catalog/';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const a = stripTar(appTgz, 'node_modules/oap-sdk');
if (a.names.some((n) => /oap-sdk/.test(n))) throw new Error('oap-sdk left in the package');
if (!a.names.some((n) => /javascript\/app\.js$/.test(n))) throw new Error('no javascript/app.js in the package');
const appName = app.id + '@' + app.version + '.tgz', toolName = tool.id + '@' + tool.version + '.tgz', iconName = app.id + '.png';
fs.writeFileSync(path.join(out, appName), a.gz);
const t = fs.readFileSync(toolTgz);
fs.writeFileSync(path.join(out, toolName), t);
const icon = fs.readFileSync(path.join(root, 'dist', app.id, ...'rhmiData/resources/tbw_mdrive_icon.png'.split('/')));
fs.writeFileSync(path.join(out, iconName), icon);

const catalog = { schema: 2, components: [
    { id: app.id, kind: 'app', title: app.title, description: app.description, author: 'TunedByWali / TBW Performance', version: app.version,
        artifact: { name: appName, size: a.gz.length, sha256: sha(a.gz), url: base + encodeURIComponent(appName) },
        icon: iconName, iconSha256: sha(icon),
        requires: { [tool.id]: tool.version, 'mgu-render': '0.6.11', 'mgu-deploy': '0.7.16' }, uninstallable: true, mguHmi: ['ID8'] },
    { id: tool.id, kind: 'tool', title: tool.title, description: tool.description, author: 'TunedByWali / TBW Performance', version: tool.version,
        artifact: { name: toolName, size: t.length, sha256: sha(t), url: base + encodeURIComponent(toolName) },
        requires: tool.requires, optional: true, uninstallable: true, mguHmi: tool.mguHmi },
] };
fs.writeFileSync(path.join(out, 'catalog.json'), JSON.stringify(catalog, null, 1) + '\n');
console.log('catalog: ' + fs.readdirSync(out).join(', '));
