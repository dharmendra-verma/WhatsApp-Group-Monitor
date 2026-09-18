/**
 * Compatibility patch for whatsapp-web.js with WhatsApp Web 2.3000.104xxxx+.
 *
 * WhatsApp Web renamed the serialized form of message keys from `_serialized`
 * to `$1`. whatsapp-web.js (<= 1.34.7) still reads `key._serialized`, which makes
 * `client.getChats()` fail with an IndexedDB "No key or key range specified"
 * error (surfaced as `r: r`) and leaves `message.id._serialized` undefined,
 * which breaks `message.delete()`.
 *
 * This script restores `_serialized` in two places:
 *   1. In the browser: a getter on the MsgKey prototype (Injected/Utils.js).
 *   2. In Node: copy `$1` to `_serialized` on Message ids (structures/Message.js).
 *
 * It is idempotent, and only warns (never fails the install) if the library
 * code has changed, e.g. after an upstream fix.
 * Upstream tracking: https://github.com/wwebjs/whatsapp-web.js/pull/201910
 */
const fs = require('fs');
const path = require('path');

const MARKER = 'WWEBJS_KEY_COMPAT';
const base = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src');

const patches = [
    {
        file: path.join('util', 'Injected', 'Utils.js'),
        anchor: 'window.WWebJS = {};',
        code:
            ` /* ${MARKER} */ try { const P = window.require('WAWebMsgKey').prototype;` +
            ` if (P && !Object.getOwnPropertyDescriptor(P, '_serialized'))` +
            ` Object.defineProperty(P, '_serialized', { configurable: true,` +
            ` get() { return typeof this.$1 === 'string' ? this.$1 : this.toString(); } }); } catch (e) {}`,
    },
    {
        file: path.join('structures', 'Message.js'),
        anchor: 'this.id = data.id;',
        code:
            ` /* ${MARKER} */ if (this.id && this.id._serialized === undefined && typeof this.id.$1 === 'string')` +
            ` this.id._serialized = this.id.$1;`,
    },
];

if (!fs.existsSync(base)) {
    console.log('[patch-wwebjs] whatsapp-web.js not installed, skipping');
    process.exit(0);
}

for (const { file, anchor, code } of patches) {
    const target = path.join(base, file);
    const src = fs.readFileSync(target, 'utf8');
    if (src.includes(MARKER)) {
        console.log(`[patch-wwebjs] ${file}: already patched`);
    } else if (!src.includes(anchor)) {
        console.warn(`[patch-wwebjs] ${file}: anchor not found, skipping (library changed - check if the upstream fix landed)`);
    } else {
        fs.writeFileSync(target, src.replace(anchor, anchor + code));
        console.log(`[patch-wwebjs] ${file}: patched`);
    }
}
