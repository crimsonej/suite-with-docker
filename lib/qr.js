// Terminal QR renderer.
//
// Replaces qrcode-terminal's `small` mode, which produced codes that often
// failed to scan:
//   • its quiet zone is only ½ module on top (QR sizes are always odd, which
//     hits a bug in its border logic) — scanners need clear space around it;
//   • "white" is drawn in the terminal's foreground colour, so on light-themed
//     terminals / log viewers the code comes out inverted;
//   • it uses error-correction level L, the least tolerant to glitches.
//
// We reuse qrcode-terminal's vendored encoder (no new dependency), and render
// with explicit black-on-white colours, a proper quiet zone and level M.
//
// Env:
//   QR_MODE=small (default) — half-block chars, 2 modules per character row
//   QR_MODE=large           — 2 spaces per module; bigger, but immune to the
//                             line-spacing gaps some log viewers add
//   QR_QUIET=<n>            — quiet-zone width in modules (default 4)

const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

const ESC = '\x1b[';
const BLACK_ON_WHITE = `${ESC}30;47m`;
const RESET = `${ESC}0m`;

function buildMatrix(text, quiet) {
    const qr = new QRCode(-1, QRErrorCorrectLevel.M);
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const size = n + quiet * 2;
    const m = [];
    for (let r = 0; r < size; r++) {
        const row = new Array(size).fill(false);
        const qrRow = r - quiet;
        if (qrRow >= 0 && qrRow < n) {
            for (let c = 0; c < n; c++) row[c + quiet] = !!qr.modules[qrRow][c];
        }
        m.push(row);
    }
    return m;
}

function renderSmall(m) {
    const lines = [];
    for (let r = 0; r < m.length; r += 2) {
        const top = m[r];
        const bottom = m[r + 1] || new Array(top.length).fill(false);
        let line = '';
        for (let c = 0; c < top.length; c++) {
            // Foreground is black (dark module), background white (light module).
            if (top[c] && bottom[c]) line += '█';      // █
            else if (top[c]) line += '▀';              // ▀
            else if (bottom[c]) line += '▄';           // ▄
            else line += ' ';
        }
        lines.push(BLACK_ON_WHITE + line + RESET);
    }
    return lines.join('\n');
}

function renderLarge(m) {
    const dark = `${ESC}40m  `;
    const light = `${ESC}47m  `;
    return m.map(row => row.map(d => (d ? dark : light)).join('') + RESET).join('\n');
}

function renderQR(text, opts = {}) {
    const mode = (opts.mode || process.env.QR_MODE || 'small').toLowerCase();
    const quietEnv = Number.parseInt(process.env.QR_QUIET, 10);
    const quiet = Number.isInteger(opts.quiet) ? opts.quiet : (Number.isInteger(quietEnv) && quietEnv >= 0 ? quietEnv : 4);
    const m = buildMatrix(text, quiet);
    return mode === 'large' ? renderLarge(m) : renderSmall(m);
}

// Print in a single write so concurrent log lines can't split the code.
function printQR(text, header = '') {
    const out = (header ? header + '\n' : '') + renderQR(text) + '\n';
    process.stdout.write(out);
}

module.exports = { renderQR, printQR, buildMatrix };
