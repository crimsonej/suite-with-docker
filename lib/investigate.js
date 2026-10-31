'use strict';

const axios = require('axios');
const dns = require('dns').promises;
const net = require('net');

const UA = process.env.USER_AGENT || 'Mozilla/5.0 (compatible; Suites/1.0)';
const MAX_PAGE_BYTES = Number(process.env.INVESTIGATE_MAX_PAGE_BYTES) || 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = Number(process.env.INVESTIGATE_MAX_IMAGE_BYTES) || 8 * 1024 * 1024;

function isPublicIp(ip) {
    if (net.isIP(ip) === 4) {
        const p = ip.split('.').map(Number), [a,b,c] = p;
        return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 || (b === 2 && c === 0))) ||
            (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
    }
    if (net.isIP(ip) !== 6) return false;
    const s = ip.toLowerCase().split('%')[0];
    const firstHextet = parseInt(s.split(':')[0] || '0', 16);
    return firstHextet >= 0x2000 && firstHextet <= 0x3fff && !s.startsWith('2001:db8:');
}

async function validateUrl(input) {
    const url = input instanceof URL ? new URL(input.href) : new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP(S) URLs are allowed.');
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Private or local hosts are blocked.');
    const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true, verbatim: true })).map(x => x.address);
    if (!ips.length || ips.some(ip => !isPublicIp(ip))) throw new Error('The host resolves to a private or reserved address.');
    return { url, ips };
}

async function getPublic(url, options = {}) {
    let current = new URL(url);
    for (let redirects = 0; redirects <= 4; redirects++) {
        const { ips } = await validateUrl(current);
        const pin = ips[0];
        const family = net.isIP(pin);
        const agent = current.protocol === 'https:'
            ? new (require('https').Agent)({ lookup: (_host, _opts, cb) => cb(null, pin, family) })
            : new (require('http').Agent)({ lookup: (_host, _opts, cb) => cb(null, pin, family) });
        let response;
        try {
            response = await axios.get(current.href, {
                ...options, httpAgent: current.protocol === 'http:' ? agent : undefined,
                httpsAgent: current.protocol === 'https:' ? agent : undefined,
                maxRedirects: 0, timeout: options.timeout || 15000,
                maxContentLength: options.maxBytes || MAX_PAGE_BYTES,
                maxBodyLength: options.maxBytes || MAX_PAGE_BYTES,
                validateStatus: s => (s >= 200 && s < 300) || [301,302,303,307,308].includes(s)
            });
        } finally { agent.destroy(); }
        if (![301,302,303,307,308].includes(response.status)) return response;
        const location = response.headers.location;
        if (!location || redirects === 4) throw new Error('Too many or invalid redirects.');
        current = new URL(location, current);
    }
}

function decodeEntities(str) {
    return String(str).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
}
function extractMeta(html, name) {
    const attr = '(?:property|name|itemprop)';
    const a = html.match(new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'));
    const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${name}["']`, 'i'));
    return (a || b) ? decodeEntities((a || b)[1]).slice(0, 300) : null;
}
async function fetchPageSummary(input) {
    try {
        const checked = await validateUrl(input);
        const res = await getPublic(checked.url.href, { responseType: 'text', maxBytes: MAX_PAGE_BYTES, headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
        const html = typeof res.data === 'string' ? res.data : '';
        const title = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        return { ok: true, status: res.status, finalUrl: res.request?.res?.responseUrl || checked.url.href, contentType: res.headers['content-type'] || '', title: extractMeta(html, 'og:title') || extractMeta(html, 'twitter:title') || (title ? decodeEntities(title[1]).trim().slice(0, 300) : null), description: extractMeta(html, 'og:description') || extractMeta(html, 'twitter:description') || extractMeta(html, 'description'), site: extractMeta(html, 'og:site_name'), ips: checked.ips.slice(0, 3) };
    } catch (err) { return { ok: false, error: err.message }; }
}
async function fetchScreenshotBuffer(input) {
    try {
        const { url } = await validateUrl(input);
        for (const providerUrl of [
            `https://s.wordpress.com/mshots/v1/${encodeURIComponent(url.href)}?w=600`,
            `https://api.microlink.io/?url=${encodeURIComponent(url.href)}&screenshot=true`
        ]) {
            const res = await axios.get(providerUrl, { timeout: 20000, maxRedirects: 3, maxContentLength: providerUrl.includes('microlink') ? 1024 * 1024 : MAX_IMAGE_BYTES, responseType: providerUrl.includes('microlink') ? 'json' : 'arraybuffer', headers: { 'User-Agent': UA } });
            const shotUrl = providerUrl.includes('microlink') ? res.data?.data?.screenshot?.url : null;
            if (shotUrl) {
                const { url: safeShotUrl } = await validateUrl(shotUrl);
                const shot = await getPublic(safeShotUrl.href, { responseType: 'arraybuffer', timeout: 20000, maxBytes: MAX_IMAGE_BYTES });
                if (shot.data?.byteLength > 2000) return Buffer.from(shot.data);
            } else if (res.data?.byteLength > 15000) return Buffer.from(res.data);
        }
    } catch (_) {}
    return null;
}
function buildInvestigateReport(parsedUrl, summary, ips) {
    const lines = ['🔍 *Investigation Report*', '──────────────────', `🌐 URL: ${summary?.finalUrl || parsedUrl.href}`];
    if (summary?.title) lines.push(`📌 Title: ${summary.title}`);
    if (summary?.description) lines.push(`📝 Summary: ${summary.description}`);
    if (summary?.site) lines.push(`🏢 Site: ${summary.site}`);
    if (ips?.length) lines.push(`🖥️ IP: ${ips.join(', ')}`);
    if (summary?.ok) { lines.push(`🔗 Status: ${summary.status}`); if (summary.contentType) lines.push(`📦 Type: ${summary.contentType.split(';')[0]}`); }
    else lines.push(`⚠️ Page fetch: ${summary?.error || 'failed'}`);
    return lines.join('\n');
}
async function handleCommand(args, msg, sock, from, replyOrEdit) {
    const imageModes = new Set(['image', 'img', 'shot', 'screenshot', 'pic']);
    const summaryModes = new Set(['summary', 'sum', 'text', 'info', 'meta']);
    let urlArg = null, mode = null;
    for (const arg of args) {
        const lower = arg.toLowerCase();
        if (imageModes.has(lower)) { mode = 'image'; continue; }
        if (summaryModes.has(lower)) { mode = 'summary'; continue; }
        if (!urlArg) urlArg = arg;
    }
    if (!urlArg) {
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const text = quoted?.conversation || quoted?.extendedTextMessage?.text || '';
        const match = text.match(/https?:\/\/[^\s<>"']+/i) || text.match(/[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?:\/[^\s]*)?/);
        if (match) urlArg = match[0];
    }
    if (!urlArg) {
        await replyOrEdit(sock, from, { text: '🔍 *Investigate* — screenshot + summary of a URL.\n\nUsage:\n• ./investigate <url>\n• ./investigate <url> image|summary\n• ./investigate image|summary (while replying to a message with a link)' }, msg);
        return;
    }
    const rawUrl = /^https?:\/\//i.test(urlArg) ? urlArg : `https://${urlArg}`;
    let parsed;
    try { ({ url: parsed } = await validateUrl(rawUrl)); }
    catch (_) {
        await replyOrEdit(sock, from, { text: `❌ Invalid or restricted URL: ${rawUrl}` }, msg);
        return;
    }
    await replyOrEdit(sock, from, { text: `🔍 Investigating ${parsed.hostname}...\nThis can take 5–25s depending on the site.` }, msg);
    const shot = mode === 'summary' ? null : await fetchScreenshotBuffer(parsed.href);
    const summary = mode === 'image' ? null : await fetchPageSummary(parsed.href);
    const report = summary ? buildInvestigateReport(parsed, summary, summary.ips) : `🔍 *Investigation Report*\n🌐 URL: ${parsed.href}`;
    if (mode === 'image') {
        if (shot) await sock.sendMessageResilient(from, { image: shot, caption: `🔍 Screenshot: ${parsed.href}` }, { quoted: msg });
        else await replyOrEdit(sock, from, { text: `❌ Could not capture a screenshot of ${parsed.href} (provider timeout or block).` }, msg);
    } else if (shot) await sock.sendMessageResilient(from, { image: shot, caption: report }, { quoted: msg });
    else await replyOrEdit(sock, from, { text: `${report}\n\n⚠️ Screenshot unavailable.` }, msg);
}
module.exports = { validateUrl, fetchPageSummary, fetchScreenshotBuffer, buildInvestigateReport, handleCommand };
