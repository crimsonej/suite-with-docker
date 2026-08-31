const { getContentType, downloadContentFromMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('ffmpeg-static');
const { getMenu } = require('./menu');
const { saveVault, getVault } = require('./vault');
const { getSettings, saveSettings } = require('./settings');
const analyzer = require('./analyzer');
const axios = require('axios');
const { Resolver } = require('dns').promises;
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { logCommand, logEdit, resolveName, formatUserLabel, isSenderMe } = require('./logger');

const sharedResolver = new Resolver();
sharedResolver.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1']);

if (typeof global.analyzer === 'undefined') {
    global.analyzer = analyzer;
}

const dnsCache = new Map();
const DNS_CACHE_TTL = 5 * 60 * 1000;

function fixBuffers(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
        return Buffer.from(obj.data);
    }
    for (const key of Object.keys(obj)) {
        if (obj[key] && typeof obj[key] === 'object') {
            if (obj[key].type === 'Buffer' && Array.isArray(obj[key].data)) {
                obj[key] = Buffer.from(obj[key].data);
            } else if (typeof obj[key] === 'object') {
                fixBuffers(obj[key]);
            }
        }
    }
    return obj;
}

// Resolve a JID to a displayable phone number. Falls back to LID digits
// if the user is LID-only with no known phone number.

async function resolveWithGoogleDNS(hostname) {
    if (dnsCache.has(hostname)) {
        const cached = dnsCache.get(hostname);
        if (Date.now() - cached.timestamp < DNS_CACHE_TTL) return cached.ip;
        dnsCache.delete(hostname);
    }

    try {
        const ips = await sharedResolver.resolve4(hostname);
        if (!ips || ips.length === 0) throw new Error(`No IP addresses found for ${hostname}`);
        const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        const validIP = ips.find(ip => ipRegex.test(ip)) || ips[0];
        dnsCache.set(hostname, { ip: validIP, timestamp: Date.now() });
        return validIP;
    } catch (error) {
        console.error(`[DNS] Failed to resolve ${hostname}:`, error.message);
        throw error;
    }
}

function validatePublicIP(ip) {
    if (!ip) return false;
    const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    if (!ipRegex.test(ip)) return false;

    const parts = ip.split('.').map(Number);
    const a = parts[0];
    const b = parts[1];

    const isPrivate = a === 10 ||
                     a === 127 ||
                     (a === 192 && b === 168) ||
                     (a === 172 && b >= 16 && b <= 31) ||
                     a === 0 ||
                     (a === 169 && b === 254) ||
                     (a >= 224);

    return !isPrivate;
}

function formatUptime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours}h ${minutes}m ${secs}s`;
}

function getDocumentMimeType(filename) {
    const extension = path.extname(filename).toLowerCase();
    const mimeTypes = {
        '.m4a': 'audio/mp4',
        '.mp3': 'audio/mpeg',
        '.ogg': 'audio/ogg',
        '.opus': 'audio/opus',
        '.webm': 'audio/webm'
    };
    return mimeTypes[extension] || 'application/octet-stream';
}

let ffmpegPath = ffmpegInstaller;
try {
    const { execSync } = require('child_process');
    execSync(`"${ffmpegInstaller}" -version`, { stdio: 'ignore', timeout: 5000 });
} catch (ffmpegErr) {
    try {
        const { execSync } = require('child_process');
        execSync('ffmpeg -version', { stdio: 'ignore', timeout: 5000 });
        ffmpegPath = 'ffmpeg';
        console.log('[FFMPEG] Using system FFmpeg binary fallback.');
    } catch (_) {
        console.warn('[FFMPEG] ⚠ ffmpeg-static binary check warning:', ffmpegErr.message);
    }
}
ffmpeg.setFfmpegPath(ffmpegPath);

const SUITE_VERSION = require(path.join(__dirname, '..', 'package.json')).version;

async function downloadWithRetry(content, type, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            fixBuffers(content);
            const stream = await downloadContentFromMessage(content, type);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            return buffer;
        } catch (err) {
            lastErr = err;
            if (i < attempts - 1) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        }
    }
    throw lastErr;
}

async function replyOrEdit(sock, from, content, msg, options = {}) {
    try {
        const isMe = isSenderMe(sock, msg);
        if (isMe && typeof content === 'object' && content.text &&
            !content.image && !content.video && !content.document && !content.sticker && !content.audio) {
            
            const editKey = {
                remoteJid: from,
                id: msg.key.id,
                fromMe: true,
                ...(msg.key.participant ? { participant: msg.key.participant } : {})
            };

            return await sock.sendMessage(from, {
                text: content.text,
                mentions: content.mentions,
                edit: editKey
            });
        }
    } catch (err) {
        console.log('[REPLY-OR-EDIT] In-place edit failed, falling back:', err.message);
    }
    return await sock.sendMessageResilient(from, content, { quoted: msg, ...options });
}

// ── ./investigate helpers ──
const INVESTIGATE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function decodeEntities(str) {
    return String(str)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

function extractMeta(html, name) {
    const attr = '(?:property|name|itemprop)';
    const re1 = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${name}["']`, 'i');
    const m = html.match(re1) || html.match(re2);
    if (!m) return null;
    try { return decodeEntities(m[1]).slice(0, 300); } catch (_) { return null; }
}

async function fetchPageSummary(url) {
    try {
        const res = await axios.get(url, {
            timeout: 20000,
            maxRedirects: 5,
            responseType: 'text',
            headers: { 'User-Agent': INVESTIGATE_UA, 'Accept-Language': 'en-US,en;q=0.9' },
            validateStatus: () => true
        });
        const html = typeof res.data === 'string' ? res.data : '';
        const finalUrl = res.request?.res?.responseUrl || url;
        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        return {
            ok: true,
            status: res.status,
            finalUrl,
            contentType: res.headers['content-type'] || '',
            title: extractMeta(html, 'og:title') || extractMeta(html, 'twitter:title') || (titleMatch ? decodeEntities(titleMatch[1]).trim().slice(0, 300) : null),
            description: extractMeta(html, 'og:description') || extractMeta(html, 'twitter:description') || extractMeta(html, 'description'),
            site: extractMeta(html, 'og:site_name') || null
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

async function fetchScreenshotBuffer(url) {
    try {
        const mshotRes = await axios.get(`https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=600`, {
            responseType: 'arraybuffer',
            timeout: 20000,
            headers: { 'User-Agent': INVESTIGATE_UA },
            validateStatus: (s) => s >= 200 && s < 300
        });
        const mshotBuf = Buffer.from(mshotRes.data);
        if (mshotBuf.length > 15000) return mshotBuf;
    } catch (_) {}

    try {
        const meta = await axios.get(`https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true`, { timeout: 25000 });
        const shotUrl = meta.data?.data?.screenshot?.url;
        if (shotUrl) {
            const res = await axios.get(shotUrl, {
                responseType: 'arraybuffer',
                timeout: 25000,
                headers: { 'User-Agent': INVESTIGATE_UA },
                validateStatus: (s) => s >= 200 && s < 300
            });
            const buf = Buffer.from(res.data);
            if (buf.length > 2000) return buf;
        }
    } catch (_) {}
    return null;
}

async function resolveHostIPs(hostname) {
    try {
        const ips = await sharedResolver.resolve4(hostname);
        return ips.slice(0, 3);
    } catch (_) { return []; }
}

function buildInvestigateReport(parsedUrl, summary, ips) {
    const lines = [];
    lines.push('🔍 *Investigation Report*');
    lines.push('──────────────────');
    lines.push(`🌐 URL: ${summary?.finalUrl || parsedUrl.href}`);
    if (summary?.title) lines.push(`📌 Title: ${summary.title}`);
    if (summary?.description) lines.push(`📝 Summary: ${summary.description}`);
    if (summary?.site) lines.push(`🏢 Site: ${summary.site}`);
    if (ips?.length) lines.push(`🖥️ IP: ${ips.join(', ')}`);
    if (summary?.ok) {
        lines.push(`🔗 Status: ${summary.status}`);
        if (summary.contentType) lines.push(`📦 Type: ${summary.contentType.split(';')[0]}`);
    } else {
        lines.push(`⚠️ Page fetch: ${summary?.error || 'failed'}`);
    }
    return lines.join('\n');
}

// ── ./yt helpers ──────────────────────────────────────────────────────────
const YT_DLP_BIN = process.env.YT_DLP_BIN || 'yt-dlp';
const MAX_VIDEO_BYTES_INLINE = 16 * 1024 * 1024;   // 16 MB WhatsApp inline cap
const MAX_VIDEO_BYTES_DOC    = 200 * 1024 * 1024;  // 200 MB document cap
const YT_DOWNLOAD_TIMEOUT_MS = 180_000;
const YT_SEARCH_TIMEOUT_MS   = 90_000;

function isUrl(s) {
    if (!s) return false;
    const t = String(s).trim();
    return /^https?:\/\//i.test(t) || /^(www\.)?youtu(be\.com|\.be)/i.test(t);
}

function formatDuration(s) {
    s = Math.max(0, parseInt(s, 10) || 0);
    const h  = Math.floor(s / 3600);
    const m  = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatViews(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
}

function sanitizeTitle(t, max = 120) {
    if (!t) return '';
    // Strip filesystem-hostile + control chars
    let s = String(t).replace(/[\x00-\x1f<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
    if (s.length > max) s = s.slice(0, max).trim();
    return s;
}

function createProgressBar(percent, width = 20) {
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    return `[${bar}]`;
}

function runYtDlp(args, timeoutMs, ownerJid = null) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let killed = false;
        let child;
        try {
            child = spawn(YT_DLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            resolve({ code: -1, stdout: '', stderr: `spawn error: ${err.message}`, killed: false });
            return;
        }

        // Register this child process so it can be cancelled via ./yt cancel
        if (ownerJid && typeof global !== 'undefined') {
            if (!global.ytActiveProcesses) global.ytActiveProcesses = new Map();
            global.ytActiveProcesses.set(ownerJid, child);
        }
        const killer = setTimeout(() => {
            killed = true;
            try { child.kill('SIGKILL'); } catch (_) {}
        }, timeoutMs);

        child.stdout.on('data', (b) => { stdout += b.toString(); });
        child.stderr.on('data', (b) => { stderr += b.toString(); });
        child.on('error', (err) => {
            clearTimeout(killer);
            if (ownerJid && global.ytActiveProcesses?.get(ownerJid) === child) {
                global.ytActiveProcesses.delete(ownerJid);
            }
            resolve({ code: -1, stdout, stderr: stderr + `\nspawn error: ${err.message}`, killed });
        });
        child.on('close', (code) => {
            clearTimeout(killer);
            if (ownerJid && global.ytActiveProcesses?.get(ownerJid) === child) {
                global.ytActiveProcesses.delete(ownerJid);
            }
            const tail = stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 300);
            console.log(`[YT-DLP] code=${code} killed=${killed} stderr_tail=${tail || '(empty)'}`);
            resolve({ code, stdout, stderr, killed });
        });
    });
}

// Run yt-dlp with real-time progress callback
function runYtDlpWithProgress(args, timeoutMs, onProgress, ownerJid = null) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let killed = false;
        let child;
        try {
            child = spawn(YT_DLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            resolve({ code: -1, stdout: '', stderr: `spawn error: ${err.message}`, killed: false });
            return;
        }

        // Register this child process so it can be cancelled via ./yt cancel
        if (ownerJid && typeof global !== 'undefined') {
            if (!global.ytActiveProcesses) global.ytActiveProcesses = new Map();
            global.ytActiveProcesses.set(ownerJid, child);
        }
        const killer = setTimeout(() => {
            killed = true;
            try { child.kill('SIGKILL'); } catch (_) {}
        }, timeoutMs);

        child.stdout.on('data', (b) => { stdout += b.toString(); });
        
        child.stderr.on('data', (b) => {
            const chunk = b.toString();
            stderr += chunk;
            
            // Parse progress: "[download] 45.3% of ~120.00MB at 2.50MiB/s ETA 00:30"
            const progressMatch = chunk.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\w*)\s+at\s+([\d.]+\w+\/s)\s+ETA\s+([\d:]+)/);
            if (progressMatch && onProgress) {
                try {
                    onProgress({
                        percent: parseFloat(progressMatch[1]),
                        total: progressMatch[2],
                        speed: progressMatch[3],
                        eta: progressMatch[4]
                    });
                } catch (_) {}
            }
        });
        
        child.on('error', (err) => {
            clearTimeout(killer);
            if (ownerJid && global.ytActiveProcesses?.get(ownerJid) === child) {
                global.ytActiveProcesses.delete(ownerJid);
            }
            resolve({ code: -1, stdout, stderr: stderr + `\nspawn error: ${err.message}`, killed });
        });
        
        child.on('close', (code) => {
            clearTimeout(killer);
            if (ownerJid && global.ytActiveProcesses?.get(ownerJid) === child) {
                global.ytActiveProcesses.delete(ownerJid);
            }
            const tail = stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 300);
            console.log(`[YT-DLP] code=${code} killed=${killed} stderr_tail=${tail || '(empty)'}`);
            resolve({ code, stdout, stderr, killed });
        });
    });
}


async function ytSearch(query, ownerJid = null) {
    const { code, stdout, stderr, killed } = await runYtDlp(
        [
            `ytsearch5:${query}`,
            '-j',
            '--skip-download',
            '--no-warnings',
            '--no-playlist',
            '--user-agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            '--referer', 'https://www.youtube.com/',
            '--socket-timeout', '30',
            '--retries', '5',
            '--sleep-interval', '3',
            '--sleep-requests', '2',
            '--no-check-certificate',
            '--force-ipv4',
            '--geo-bypass',
            '--extractor-args', 'youtube:player_client=web_embedded'
        ],
        YT_SEARCH_TIMEOUT_MS,
        ownerJid
    );
    if (killed) throw new Error('yt-dlp search timed out or cancelled');
    if (code !== 0) {
        const tail = stderr.split('\n').slice(-2).join(' | ').slice(0, 300);
        throw new Error(`yt-dlp search failed: ${tail || stderr}`);
    }

    const parsed = stdout.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);

    if (parsed.length) {
        return parsed.slice(0, 5).map((j) => ({
            url: j.webpage_url || j.url,
            title: j.title || 'Untitled',
            channel: j.channel || j.uploader || '',
            duration: j.duration || 0,
            view_count: j.view_count || null,
            thumbnail: j.thumbnail || null
        }));
    }

    try {
        const html = await fetchYoutubeSearchHtml(query);
        const fallback = parseYoutubeSearchHtml(html);
        if (fallback.length) return fallback;
    } catch (_) {}

    return [];
}

async function ytGetInfo(url, ownerJid = null) {
    const { code, stdout, stderr, killed } = await runYtDlp(
        [
            '-j',
            '--skip-download',
            '--no-warnings',
            '--user-agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            '--referer', 'https://www.youtube.com/',
            '--socket-timeout', '30',
            '--retries', '5',
            '--sleep-interval', '3',
            '--sleep-requests', '2',
            '--no-check-certificate',
            '--force-ipv4',
            '--geo-bypass',
            '--extractor-args', 'youtube:player_client=web_embedded',
            url
        ],
        YT_SEARCH_TIMEOUT_MS,
        ownerJid
    );
    if (killed) throw new Error('ytGetInfo timed out or cancelled');
    if (code !== 0) {
        const tail = stderr.split('\n').slice(-2).join(' | ').slice(0, 300);
        throw new Error(`ytGetInfo failed: ${tail || stderr}`);
    }

    try {
        const info = JSON.parse(stdout);
        return {
            url: info.webpage_url || info.url || url,
            title: info.title || 'Untitled',
            channel: info.channel || info.uploader || '',
            duration: info.duration || 0,
            view_count: info.view_count || null,
            thumbnail: info.thumbnail || null
        };
    } catch (e) {
        throw new Error(`ytGetInfo JSON parse failed: ${e.message}`);
    }
}

function parseDurationText(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value;
    const str = String(value).trim();
    const parts = str.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return Number(parts[0]) || 0;
    return 0;
}

function parseViewCountText(value) {
    if (!value) return null;
    const str = String(value).replace(/[^\d]/g, '');
    return str ? Number(str) : null;
}

async function fetchYoutubeSearchHtml(query) {
    return new Promise((resolve, reject) => {
        const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) + '&hl=en&persist_hl=1';
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                https.get(res.headers.location, { headers: { 'User-Agent': 'Mozilla/5.0 (...) Chrome/120.0.0.0 Safari/537.36' } }, (follow) => {
                    let body = '';
                    follow.on('data', chunk => body += chunk);
                    follow.on('end', () => resolve(body));
                }).on('error', reject);
                return;
            }
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(body));
        });
        req.on('error', reject);
    });
}

function parseYoutubeSearchHtml(html) {
    if (!html) return [];
    const match = html.match(/var ytInitialData = (.*?);\s*(?:var|<\/script>)/s);
    if (!match) return [];
    try {
        const data = JSON.parse(match[1]);
        const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
        const results = [];
        for (const section of sections) {
            const items = section?.itemSectionRenderer?.contents || [];
            for (const item of items) {
                const video = item?.videoRenderer;
                if (!video) continue;
                const id = video.videoId;
                if (!id) continue;
                const title = video.title?.runs?.map(r => r.text).join('') || video.title?.simpleText || 'Untitled';
                const channel = video.ownerText?.runs?.map(r => r.text).join('') || video.ownerText?.simpleText || video.shortBylineText?.runs?.map(r => r.text).join('') || '';
                const duration = parseDurationText(video.lengthText?.simpleText || 0);
                const viewText = video.viewCountText?.simpleText || video.shortViewCountText?.simpleText || null;
                const views = parseViewCountText(viewText);
                const thumb = video.thumbnail?.thumbnails?.slice(-1)[0]?.url || null;
                results.push({
                    url: `https://www.youtube.com/watch?v=${id}`,
                    title,
                    channel,
                    duration,
                    view_count: views,
                    thumbnail: thumb
                });
                if (results.length >= 5) return results;
            }
        }
        return results;
    } catch (_) {
        return [];
    }
}

async function _ytDownloadAndSend(sock, from, ctxMsg, mode, meta, statusKey = null, selectionKey = null) {
    const tmpDir = path.join(os.tmpdir(), `suites_yt_${crypto.randomBytes(6).toString('hex')}`);
    await fs.ensureDir(tmpDir);
    try {
        const safeTitle = sanitizeTitle(meta.title) || 'yt';
        const outTpl = path.join(tmpDir, `%(title).120B.%(ext)s`);

        // Try multiple player_client values if one fails with 403
        const playerClients = ['web_embedded', 'android', 'ios', 'web', 'mweb'];
        const videoFormats = [
            'bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=avc1]+bestaudio/best[ext=mp4]/best',
            'bestvideo[vcodec^=avc1][height<=480]+bestaudio[acodec^=mp4a]/bestvideo[height<=480]+bestaudio/best[height<=480]',
            'bestvideo[vcodec^=avc1][height<=360]+bestaudio[acodec^=mp4a]/bestvideo[height<=360]+bestaudio/best[height<=360]'
        ];
        let lastError = null;
        let progressMsg = null;
        let downloadedFile = null;
        let oversizedBytes = null;
        
        for (const format of mode === 'video' ? videoFormats : ['bestaudio/best']) {
            for (const playerClient of playerClients) {
            let args;
            if (mode === 'audio') {
                args = [
                    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
                    '-x',
                    '--audio-format', 'm4a',
                    '--audio-quality', '0',
                    '--user-agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    '--referer', 'https://www.youtube.com/',
                    '--socket-timeout', '30',
                    '--retries', '3',
                    '--sleep-interval', '2',
                    '--no-check-certificate',
                    '--no-warnings',
                    '--force-ipv4',
                    '--geo-bypass',
                    '--extractor-args', `youtube:player_client=${playerClient}`,
                    '-o', outTpl,
                    meta.url
                ];
            } else {
                args = [
                    '-f', format,
                    '--merge-output-format', 'mp4',
                    '--postprocessor-args', 'ffmpeg:-movflags +faststart',
                    '--user-agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    '--referer', 'https://www.youtube.com/',
                    '--socket-timeout', '30',
                    '--retries', '3',
                    '--sleep-interval', '2',
                    '--no-check-certificate',
                    '--no-warnings',
                    '--force-ipv4',
                    '--geo-bypass',
                    '--extractor-args', `youtube:player_client=${playerClient}`,
                    '-o', outTpl,
                    meta.url
                ];
            }

            // Reuse the search status message when this download follows a picker.
            if (playerClient === playerClients[0] && !statusKey) {
                try {
                    progressMsg = await sock.sendMessageResilient(from, {
                        text: `⏬ Starting download (${mode}): *${safeTitle}* …`
                    }, { quoted: ctxMsg });
                } catch (err) {
                    console.error('[YT] Failed to send progress message:', err.message);
                }
            } else if (playerClient === playerClients[0]) {
                progressMsg = { key: statusKey };
                try {
                    await sock.sendMessage(from, {
                        text: `⏬ Starting download (${mode}): *${safeTitle}* …`,
                        edit: statusKey
                    });
                } catch (err) {
                    console.error('[YT] Failed to edit progress message:', err.message);
                }
            }

            let lastUpdateTime = 0;
            const updateInterval = 1500; // Update progress message every 1.5s

            const { code, stderr, killed } = await runYtDlpWithProgress(
                args,
                YT_DOWNLOAD_TIMEOUT_MS,
                async (progress) => {
                    // Rate-limit updates to avoid spam
                    const now = Date.now();
                    if (now - lastUpdateTime < updateInterval) return;
                    lastUpdateTime = now;

                    if (!progressMsg?.key) return;

                    try {
                        const bar = createProgressBar(progress.percent);
                        await sock.sendMessage(from, {
                            text: `⏬ *${safeTitle}*\n${bar} ${progress.percent.toFixed(1)}%\n📊 ${progress.total} @ ${progress.speed}\n⏱️ ETA ${progress.eta}`,
                            edit: progressMsg.key
                        });
                    } catch (_) {}
                },
                from
            );

            if (killed) {
                lastError = new Error('yt-dlp timed out after 180s or was cancelled');
                continue; // Try next player_client
            }
            
            if (code !== 0) {
                const tail = stderr.split('\n').slice(-3).join(' | ').slice(0, 400);
                const errMsg = `yt-dlp exited ${code}: ${tail || stderr}`;
                
                // Check if it's a 403 error
                if (stderr.includes('403') || stderr.includes('Forbidden')) {
                    console.log(`[YT] Got 403 with ${playerClient}, trying next player_client...`);
                    lastError = new Error(errMsg);
                    continue; // Try next player_client
                } else {
                    // Non-403 error, don't retry
                    throw new Error(errMsg);
                }
            }

            const entries = await fs.readdir(tmpDir);
            const candidate = entries
                .map((f) => ({ f, p: path.join(tmpDir, f) }))
                .find((e) => /\.(opus|ogg|m4a|mp4|webm|mkv)$/i.test(e.f));
            if (!candidate) throw new Error('yt-dlp reported success but no output file was found');

            if (mode === 'video') {
                const candidateStat = await fs.stat(candidate.p);
                if (candidateStat.size > MAX_VIDEO_BYTES_DOC) {
                    oversizedBytes = candidateStat.size;
                    console.log(`[YT] ${format} produced ${(candidateStat.size / 1024 / 1024).toFixed(1)} MB; trying a smaller format`);
                    await fs.remove(candidate.p);
                    continue;
                }
            }

            downloadedFile = candidate;
            break;
            }
            if (downloadedFile) break;
        }
        
        // If we got through all player_clients without success, throw the last error
        if (!downloadedFile && lastError) {
            throw lastError;
        }

        const file = downloadedFile;
        if (!file) {
            if (oversizedBytes) {
                await sock.sendMessageResilient(from, {
                    text: `❌ Video is still too large after reducing quality: ${(oversizedBytes / 1024 / 1024).toFixed(1)} MB > 200 MB cap.`
                }, { quoted: ctxMsg });
                return;
            }
            throw new Error('yt-dlp reported success but no output file was found');
        }

        const stat = await fs.stat(file.p);
        const buf  = await fs.readFile(file.p);

        if (statusKey) {
            try {
                await sock.sendMessage(from, {
                    text: `✅ *${safeTitle}* (${mode})`,
                    edit: statusKey
                });
            } catch (_) {}
        }

        if (mode === 'audio') {
            const ext = path.extname(file.f).slice(1) || 'm4a';
            const mime = getDocumentMimeType(file.f);
            await sock.sendMessageResilient(from, {
                audio: buf,
                mimetype: mime || 'audio/mp4',
                ptt: false,
                fileName: `${safeTitle}.${ext}`
            }, { quoted: ctxMsg });
        } else {
            if (stat.size > MAX_VIDEO_BYTES_DOC) {
                await sock.sendMessageResilient(from, {
                    text: `❌ Video too large: ${(stat.size / 1024 / 1024).toFixed(1)} MB > 200 MB cap.`
                }, { quoted: ctxMsg });
                return;
            }
            if (stat.size <= MAX_VIDEO_BYTES_INLINE) {
                // Sent as inline playable video for small files <= 16MB
                await sock.sendMessageResilient(from, {
                    video: buf,
                    mimetype: 'video/mp4',
                    caption: safeTitle
                }, { quoted: ctxMsg });
            } else {
                // Sent as document attachment for files > 16MB up to 200MB to preserve full quality without compression
                await sock.sendMessageResilient(from, {
                    document: buf,
                    mimetype: 'video/mp4',
                    fileName: `${safeTitle}.mp4`,
                    caption: `📄 *${safeTitle}*\nSize: ${(stat.size / 1024 / 1024).toFixed(1)} MB (Document HD)`
                }, { quoted: ctxMsg });
            }
        }

        if (selectionKey) {
            try {
                await sock.sendMessage(from, { delete: selectionKey });
            } catch (err) {
                console.error('[YT] Failed to delete selection message:', err.message);
            }
        }
    } catch (err) {
        console.error('[YT] Download error:', err.message);
        // Try to notify the user about the error, but don't crash if this fails
        try {
            await sock.sendMessageResilient(from, {
                text: `❌ Download error: ${err.message}`
            }, { quoted: ctxMsg });
        } catch (_) {
            console.error('[YT] Failed to send error message');
        }
    } finally {
        await fs.remove(tmpDir).catch(() => {});
    }
}

async function handleMessages(sock, msg) {
    if (!msg || !msg.message) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    const sender = isGroup ? (msg.key.participant || msg.participant) : from;

    const settings = await getSettings();

    // ── Master switch (./suite off) ──
    // When disabled, everything is paused except ./suite on/off and the tracking system
    if (settings.suite_enabled === false) {
        const bodyCheck = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (!bodyCheck.startsWith('./suite') && !bodyCheck.startsWith('./track')) return;
    }

    // ── PROTOCOL: Intercept Deletions and Edits ──
    const proto = msg.message?.protocolMessage;
    if (proto) {
        const typeRaw = String(proto.type || '').toLowerCase();
        const targetId = proto.key?.id;
        const originalMsg = global.msgCache?.get(targetId);
        const isGroupProto = from.endsWith('@g.us');

        const isRevoke = typeRaw === '0' || typeRaw === 'revoke' || typeRaw === 'delete';
        const isEdit = typeRaw === '14' || typeRaw.includes('edit') || typeRaw === 'message_edit' || typeRaw === 'edited';

        if (isRevoke && originalMsg) {
            const feature = 'antidelete';
            const shouldTrigger = settings[feature].exceptions.hasOwnProperty(from)
                ? settings[feature].exceptions[from]
                : (isGroupProto ? settings[feature].global_groups : settings[feature].global_private);

            if (shouldTrigger && !isSenderMe(sock, originalMsg, settings)) {
                const participant = originalMsg.key.participant || originalMsg.key.remoteJid || from;
                await _handleAntiDelete(sock, from, originalMsg, participant, targetId);
            }
            return;
        } else if (isEdit && originalMsg) {
            const feature = 'antiedit';
            const shouldTrigger = settings[feature].exceptions.hasOwnProperty(from)
                ? settings[feature].exceptions[from]
                : (isGroupProto ? settings[feature].global_groups : settings[feature].global_private);

            if (shouldTrigger && !isSenderMe(sock, originalMsg, settings)) {
                // Extract a comparable text representation of both old and new
                // content. WhatsApp edits can swap conversation <-> extendedText
                // and can change captions on media — read all three.
                const extractText = (m) => {
                    if (!m) return '';
                    if (m.conversation) return m.conversation;
                    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
                    if (m.imageMessage?.caption)        return `[image] ${m.imageMessage.caption}`;
                    if (m.videoMessage?.caption)        return `[video] ${m.videoMessage.caption}`;
                    if (m.documentMessage?.caption)     return `[doc] ${m.documentMessage.caption}`;
                    return '';
                };
                const oldText = extractText(originalMsg.message);
                const newText = extractText(proto.editedMessage);

                logEdit(sock, from, originalMsg.key.participant || from).catch(() => {});

                if (oldText !== newText) {
                    const editorLabel = await formatUserLabel(sock, originalMsg.key.participant || from, from);
                    await sock.sendMessageResilient(from, {
                        text: `✏️ *Anti-Edit Captured*\n\nEditor: ${editorLabel}\n*Original:* ${oldText || '[Media/Non-text]'}\n*Edited:* ${newText || '[Media/Non-text]'}`
                    }, { quoted: originalMsg });
                }
            }
            return;
        }
    }

    // Parse body text and command
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    
    // Skip status messages completely
    if (from === 'status@broadcast') return;

    // ── Pending YouTube picker interception (BEFORE prefix check) ──
    // Only process if: (1) picker exists for this chat, (2) message is quoting the
    // search list, (3) sender is the original requester, (4) body is a single 1-5.
    const pickerPending = global.ytPendingPickers?.get(from);
    if (pickerPending) {
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const quotedMsgKey = contextInfo?.stanzaId;
        const bodyTrim = body.trim();
        const pickMatch = /^([1-5])\s*$/.exec(bodyTrim);
        
        // Check: is message sent by self?
        const isFromMe = isSenderMe(sock, msg, settings);
        
        // Check: is sender the original requester?
        const senderJid = jidNormalizedUser(from);
        const requesterJid = jidNormalizedUser(pickerPending.requesterJid);
        const isFromRequester = senderJid === requesterJid;
        
        // Check: is this a quoted reply?
        const isQuoted = !!contextInfo;
        const isReplyToPicker = pickerPending.statusKey?.id === quotedMsgKey;

        if (pickMatch && isQuoted && isReplyToPicker && isFromMe) {
            console.log('[YT-PICKER] Matched! Body:', bodyTrim, 'Requester match:', isFromRequester, 'Quoted:', isQuoted);
            const idx = parseInt(pickMatch[1], 10) - 1;
            const chosen = pickerPending.results[idx];
            
            if (!chosen) {
                await replyOrEdit(sock, from, {
                    text: '❌ Invalid pick — index out of range.'
                }, msg);
                return;
            }

            // Edit the user's typed number response (msg) in-place to show download progress
            const statusAck = await replyOrEdit(sock, from, {
                text: `⏬ Starting download (${pickerPending.mode}): *${chosen.title}* …`
            }, msg);

            // Clear picker immediately
            const prevSearchKey = pickerPending.statusKey;
            global.ytPendingPickers.delete(from);

            // Kick off the download in the background using statusAck.key as statusKey and prevSearchKey as selectionKey to delete
            _ytDownloadAndSend(
                sock,
                from,
                pickerPending.ctxMsg,
                pickerPending.mode,
                chosen,
                statusAck?.key || msg.key,
                prevSearchKey
            )
                .catch((e) => {
                    console.error('[YT] picker download error:', e);
                    try {
                        sock.sendMessageResilient(from, {
                            text: `❌ Download failed: ${e.message}`
                        }, { quoted: pickerPending.ctxMsg }).catch(() => {});
                    } catch (_) {
                        console.error('[YT] Failed to send error notification');
                    }
                });
            return;
        }
    }

    // Now check for ./prefix commands
    const prefix = './';
    if (!body.startsWith(prefix)) return;

    const args = body.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // ── Security Guard Check ──
    // The userbot is designed for self-use. ONLY commands sent by the bot owner (fromMe)
    // are accepted. Commands sent by external users (in private or group chats) are ignored.
    const isFromMe = isSenderMe(sock, msg, settings);
    if (!isFromMe) {
        return;
    }

    logCommand(from, command, args);

    const vaultJid = (await getVault()) || global.vault || settings.home_jid;

    switch (command) {
        case '<>': { // Anti-View-Once
            try {
                const sendToHome = args.some(a => a.toLowerCase() === 'home');
                const destJid = sendToHome ? (vaultJid || settings.home_jid || global.vault || from) : from;

                const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
                const quotedMsg = contextInfo?.quotedMessage;
                const stanzaId = contextInfo?.stanzaId;

                let mediaObj = null;
                let mediaType = null;
                let cachedBufferObj = null;

                if (stanzaId && global.viewOnceBufferCache?.has(stanzaId)) {
                    const entry = global.viewOnceBufferCache.get(stanzaId);
                    try {
                        cachedBufferObj = entry?.promise ? await entry.promise : null;
                    } catch (dlErr) {
                        console.error('[ANTI-VIEW-ONCE] Cached download failed:', dlErr.message);
                        cachedBufferObj = null;
                    }
                }

                if (cachedBufferObj) {
                    const sendKey = cachedBufferObj.mediaType === 'imageMessage' ? 'image'
                                  : cachedBufferObj.mediaType === 'videoMessage' ? 'video' : 'audio';
                    const payload = {
                        [sendKey]: cachedBufferObj.buffer,
                        mimetype: cachedBufferObj.mimetype || (sendKey === 'image' ? 'image/jpeg' : sendKey === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus')
                    };
                    if (sendKey !== 'audio') payload.caption = '🛡️ *Crimson Anti-View-Once*\nIntercepted successfully.';
                    else payload.ptt = cachedBufferObj.ptt || false;

                    if (sendToHome) {
                        await sock.sendMessageResilient(destJid, payload);
                        await replyOrEdit(sock, from, { text: 'okay' }, msg);
                    } else {
                        await sock.sendMessageResilient(from, payload, { quoted: msg });
                    }
                    return;
                }

                if (!quotedMsg) {
                    await replyOrEdit(sock, from, { text: '[Crimson] Reply to a View-Once message with `./<>` or `./<> home` to intercept.' }, msg);
                    return;
                }

                let unwrapped = quotedMsg;
                if (unwrapped.ephemeralMessage) unwrapped = unwrapped.ephemeralMessage.message;
                if (unwrapped.documentWithCaptionMessage) unwrapped = unwrapped.documentWithCaptionMessage.message;

                const voWrapper = unwrapped.viewOnceMessageV2 || unwrapped.viewOnceMessageV2Extension || unwrapped.viewOnceMessage;
                const inner = voWrapper ? voWrapper.message : unwrapped;

                if (inner.imageMessage) { mediaType = 'imageMessage'; mediaObj = inner.imageMessage; }
                else if (inner.videoMessage) { mediaType = 'videoMessage'; mediaObj = inner.videoMessage; }
                else if (inner.audioMessage) { mediaType = 'audioMessage'; mediaObj = inner.audioMessage; }

                if (!mediaObj) {
                    await replyOrEdit(sock, from, { text: '[Crimson] Quoted message does not contain View-Once media.' }, msg);
                    return;
                }

                mediaObj.viewOnce = false;
                const dlType = mediaType === 'imageMessage' ? 'image' : mediaType === 'videoMessage' ? 'video' : 'audio';
                const stream = await downloadContentFromMessage(mediaObj, dlType);
                let buffer = Buffer.from([]);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

                const sendKey = mediaType === 'imageMessage' ? 'image' : mediaType === 'videoMessage' ? 'video' : 'audio';
                const payload = {
                    [sendKey]: buffer,
                    mimetype: mediaObj.mimetype || (sendKey === 'image' ? 'image/jpeg' : sendKey === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus')
                };
                if (sendKey !== 'audio') payload.caption = '🛡️ *Crimson Anti-View-Once*\nIntercepted successfully.';
                else payload.ptt = mediaObj.ptt || false;

                if (sendToHome) {
                    await sock.sendMessageResilient(destJid, payload);
                    await replyOrEdit(sock, from, { text: 'okay' }, msg);
                } else {
                    await sock.sendMessageResilient(from, payload, { quoted: msg });
                }
            } catch (voErr) {
                console.error('[ANTI-VIEW-ONCE] Error:', voErr.message);
                await replyOrEdit(sock, from, { text: `❌ Anti-View-Once failed: ${voErr.message}` }, msg);
            }
            break;
        }

        case 'antidelete': {
            const subCommand = args[0]?.toLowerCase();
            const remoteJid = msg.key.remoteJid;
            const isHomeChat = jidNormalizedUser(from) === (settings.home_jid ? jidNormalizedUser(settings.home_jid) : null);
            const feature = 'antidelete';

            if (subCommand === 'on' || subCommand === 'off') {
                if (isHomeChat) {
                    settings[feature].global_private = subCommand === 'on';
                    settings[feature].exceptions = Object.fromEntries(
                        Object.entries(settings[feature].exceptions).filter(([j]) => j.endsWith('@g.us'))
                    );
                    await saveSettings(settings);
                    await replyOrEdit(sock, from, { text: `✅ Global Anti-Delete for Private Chats is now ${subCommand === 'on' ? 'ENABLED' : 'DISABLED'}.` }, msg);
                } else {
                    settings[feature].exceptions[remoteJid] = subCommand === 'on';
                    await saveSettings(settings);
                    await replyOrEdit(sock, from, { text: `✅ Anti-Delete for this chat is now ${subCommand === 'on' ? 'ENABLED' : 'DISABLED'}.` }, msg);
                }
            } else if (subCommand === 'groups') {
                const groupAction = args[1]?.toLowerCase();
                if (groupAction === 'on' || groupAction === 'off') {
                    settings[feature].global_groups = groupAction === 'on';
                    settings[feature].exceptions = Object.fromEntries(
                        Object.entries(settings[feature].exceptions).filter(([j]) => !j.endsWith('@g.us'))
                    );
                    await saveSettings(settings);
                    await replyOrEdit(sock, from, { text: `✅ Global Anti-Delete for Groups is now ${groupAction === 'on' ? 'ENABLED' : 'DISABLED'}.` }, msg);
                } else {
                    await replyOrEdit(sock, from, { text: "Usage: ./antidelete groups <on/off>" }, msg);
                }
            } else {
                const localOverride = settings[feature].exceptions.hasOwnProperty(remoteJid);
                const currentStatus = localOverride 
                    ? settings[feature].exceptions[remoteJid]
                    : (isGroup ? settings[feature].global_groups : settings[feature].global_private);
                await replyOrEdit(sock, from, { text: `🛡️ *Anti-Delete Status*: ${currentStatus ? 'ON' : 'OFF'} ${localOverride ? '(Local Override)' : '(Global)'}` }, msg);
            }
            break;
        }

        case 'antiedit': {
            const subCommand = args[0]?.toLowerCase();
            const remoteJid = msg.key.remoteJid;
            const isHomeChat = jidNormalizedUser(from) === (settings.home_jid ? jidNormalizedUser(settings.home_jid) : null);
            const feature = 'antiedit';

            if (subCommand === 'on' || subCommand === 'off') {
                if (isHomeChat) {
                    settings[feature].global_private = subCommand === 'on';
                    settings[feature].exceptions = Object.fromEntries(
                        Object.entries(settings[feature].exceptions).filter(([j]) => j.endsWith('@g.us'))
                    );
                    await saveSettings(settings);
                    await replyOrEdit(sock, from, { text: `✅ Global Anti-Edit for Private Chats is now ${subCommand === 'on' ? 'ENABLED' : 'DISABLED'}.` }, msg);
                } else {
                    settings[feature].exceptions[remoteJid] = subCommand === 'on';
                    await saveSettings(settings);
                    await replyOrEdit(sock, from, { text: `✅ Anti-Edit for this chat is now ${subCommand === 'on' ? 'ENABLED' : 'DISABLED'}.` }, msg);
                }
            } else if (subCommand === 'groups') {
                const groupAction = args[1]?.toLowerCase();
                if (groupAction === 'on' || groupAction === 'off') {
                    settings[feature].global_groups = groupAction === 'on';
                    settings[feature].exceptions = Object.fromEntries(
                        Object.entries(settings[feature].exceptions).filter(([j]) => !j.endsWith('@g.us'))
                    );
                    await saveSettings(settings);
                    await replyOrEdit(sock, from, { text: `✅ Global Anti-Edit for Groups is now ${groupAction === 'on' ? 'ENABLED' : 'DISABLED'}.` }, msg);
                } else {
                    await replyOrEdit(sock, from, { text: "Usage: ./antiedit groups <on/off>" }, msg);
                }
            } else {
                const localOverride = settings[feature].exceptions.hasOwnProperty(remoteJid);
                const currentStatus = localOverride 
                    ? settings[feature].exceptions[remoteJid]
                    : (isGroup ? settings[feature].global_groups : settings[feature].global_private);
                await replyOrEdit(sock, from, { text: `✏️ *Anti-Edit Status*: ${currentStatus ? 'ON' : 'OFF'} ${localOverride ? '(Local Override)' : '(Global)'}` }, msg);
            }
            break;
        }

        case 'suite': {
            const subCommand = args[0]?.toLowerCase();
            if (subCommand === 'on' || subCommand === 'off') {
                settings.suite_enabled = subCommand === 'on';
                await saveSettings(settings);
                await replyOrEdit(sock, from, {
                    text: settings.suite_enabled
                        ? '🛡️ *Suite ENABLED.* All systems operational.'
                        : '🔕 *Suite DISABLED.* All processing paused. Send `./suite on` to resume.'
                }, msg);
            } else {
                const formatScope = async (feature, label) => {
                    const featureSettings = settings[feature] || {};
                    const privateScope = featureSettings.global_private ? 'private chats' : null;
                    const groupScope = featureSettings.global_groups ? 'groups' : null;
                    const overrides = await Promise.all(
                        Object.entries(featureSettings.exceptions || {})
                            .map(async ([j, enabled]) => {
                                const userLabel = j.endsWith('@g.us')
                                    ? await resolveName(sock, j)
                                    : await formatUserLabel(sock, j);
                                return `${enabled ? 'ON' : 'OFF'}: ${userLabel}`;
                            })
                    );
                    const scopes = [privateScope, groupScope].filter(Boolean);
                    if (overrides.length) scopes.push(`overrides [${overrides.join(', ')}]`);
                    return `• ${label}: ${scopes.length ? scopes.join('; ') : 'OFF'}`;
                };

                const autoDeleteTargets = await Promise.all(
                    (settings.autodelete?.targets || [])
                        .filter((entry) => entry && typeof entry === 'object')
                        .map(async (entry) => {
                            const userLabel = await formatUserLabel(sock, entry.targetJid, entry.groupJid);
                            const groupName = await resolveName(sock, entry.groupJid);
                            return `${userLabel} in ${groupName}`;
                        })
                );
                const activeTools = [
                    `• Master engine: ${settings.suite_enabled ? 'ON (all enabled tools running)' : 'OFF (processing paused)'}`,
                    await formatScope('antidelete', 'Anti-delete'),
                    await formatScope('antiedit', 'Anti-edit'),
                    `• Auto-delete: ${autoDeleteTargets.length ? `ON for ${autoDeleteTargets.join(', ')}` : 'OFF (no targets configured)'}`
                ];
                await replyOrEdit(sock, from, {
                    text: `🛡️ *Suite Tools & Scope*\n\n${activeTools.join('\n')}\n\nUsage: ./suite <on/off>`
                }, msg);
            }
            break;
        }

        case 'status': {
            const serverName = settings.session_name || os.hostname() || 'Suites Engine';
            const totalRAM = os.totalmem();
            const freeRAM = os.freemem();
            const usedRAMMB = ((totalRAM - freeRAM) / 1024 / 1024).toFixed(1);
            const totalRAMGB = (totalRAM / 1024 / 1024 / 1024).toFixed(1);
            const ramPct = Math.round(((totalRAM - freeRAM) / totalRAM) * 100);
            const uptime = formatUptime(process.uptime());

            let diskLine = '❯ Disk      : n/a';
            try {
                const st = fs.statfsSync('/');
                const totalGB = (st.bsize * st.blocks) / 1024 / 1024 / 1024;
                const freeGB = (st.bsize * st.bavail) / 1024 / 1024 / 1024;
                const usedGB = totalGB - freeGB;
                const diskPct = Math.round((1 - st.bavail / st.blocks) * 100);
                diskLine = `❯ Disk      : ${usedGB.toFixed(1)}GB / ${totalGB.toFixed(1)}GB (${diskPct}%)`;
            } catch (_) {}

            let netLine = '❯ Network   : n/a';
            try {
                const ifaces = os.networkInterfaces();
                for (const [name, addrs] of Object.entries(ifaces)) {
                    if (/^(lo|docker|br-|veth|tailscale|virbr|tun)/.test(name)) continue;
                    const v4 = (addrs || []).find(a => a.family === 'IPv4' && !a.internal);
                    if (v4) { netLine = `❯ Interface : ${name}`; break; }
                }
            } catch (_) {}

            const connState = sock?.ws?.isOpen ? '🟢 Connected' : '🔴 Disconnected';

            const statusArt = `╔════════════════════════════════╗
║       ✦ *SUITE STATUS* ✦       ║
╠════════════════════════════════╣
║ ❯ Engine     : v${SUITE_VERSION} · Node ${process.version.slice(1)}
║ ❯ Connection : ${connState}
║ ${netLine}
║ ❯ OS         : ${os.platform()} ${os.arch()}
║ ❯ RAM        : ${usedRAMMB}MB / ${totalRAMGB}GB (${ramPct}%)
║ ${diskLine}
║ ❯ Uptime     : ${uptime}
║ ❯ State      : ${settings.suite_enabled ? '🟢 ON' : '🔴 OFF'}
║ ❯ Server     : ${serverName}
╚════════════════════════════════╝`;

            await replyOrEdit(sock, from, { text: statusArt }, msg);
            break;
        }

        case 'dp': {
            const sendToHome = args.some(a => a.toLowerCase() === 'home');
            const nonHomeArgs = args.filter(a => a.toLowerCase() !== 'home');

            if (!sendToHome) {
                await replyOrEdit(sock, from, { text: '🔍 Fetching Profile Picture...' }, msg);
            }

            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.participant;

            // Target resolution: ./dp <number|jid> [home] > ./dp @mention > reply > self
            const argTarget = (nonHomeArgs[0] || '').replace(/^\+/, '');
            let target;
            if (/^\d+$/.test(argTarget)) {
                target = `${argTarget}@s.whatsapp.net`;
            } else if (/^[^@\s]+@[^@\s]+$/.test(argTarget)) {
                target = argTarget;
            } else if (mentioned && mentioned[0]) {
                target = mentioned[0];
            } else if (quoted) {
                target = quoted;
            } else {
                target = from;
            }

            try {
                let ppUrl = null;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        ppUrl = await sock.profilePictureUrl(target, 'image');
                        if (ppUrl) break;
                    } catch (err) {
                        console.log(`[DP] profilePictureUrl attempt ${attempt} failed:`, err.message);
                        if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
                    }
                }
                if (!ppUrl) {
                    await replyOrEdit(sock, from, { text: '❌ No profile picture found for this user or request timed out after 3 attempts.' }, msg);
                    break;
                }

                // Download image buffer directly with retry
                let res = null;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        res = await axios.get(ppUrl, { responseType: 'arraybuffer', timeout: 30000 });
                        break;
                    } catch (err) {
                        console.log(`[DP] image download attempt ${attempt} failed:`, err.message);
                        if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
                    }
                }
                if (!res) {
                    await replyOrEdit(sock, from, { text: '❌ Failed to download profile picture after 3 attempts.' }, msg);
                    break;
                }
                const imgBuffer = Buffer.from(res.data);

                const targetLabel = await formatUserLabel(sock, target, from);
                const destJid = sendToHome ? (vaultJid || settings.home_jid || global.vault || from) : from;

                if (sendToHome) {
                    await sock.sendMessageResilient(destJid, {
                        image: imgBuffer,
                        caption: `🖼️ *DP Captured*: ${targetLabel}`,
                        mentions: [target]
                    });
                    await replyOrEdit(sock, from, { text: 'okay' }, msg);
                } else {
                    await sock.sendMessageResilient(from, {
                        image: imgBuffer,
                        caption: `🖼️ *DP Captured*: ${targetLabel}`,
                        mentions: [target]
                    }, { quoted: msg });

                    if (vaultJid && vaultJid !== from) {
                        try {
                            await sock.sendMessageResilient(vaultJid, {
                                image: imgBuffer,
                                caption: `🖼️ *DP Captured*: ${targetLabel}`,
                                mentions: [target]
                            });
                        } catch (_) {}
                    }
                }
            } catch (err) {
                console.error('[DP] Error fetching DP:', err.message);
                await replyOrEdit(sock, from, { text: `❌ Failed to fetch DP: ${err.message}` }, msg);
            }
            break;
        }

        case 'investigate': {
            const MODE_IMAGE = new Set(['image', 'img', 'shot', 'screenshot', 'pic']);
            const MODE_SUMMARY = new Set(['summary', 'sum', 'text', 'info', 'meta']);

            let urlArg = null;
            let mode = null;

            for (const a of args) {
                const low = a.toLowerCase();
                if (MODE_IMAGE.has(low)) { mode = 'image'; continue; }
                if (MODE_SUMMARY.has(low)) { mode = 'summary'; continue; }
                if (!urlArg) urlArg = a;
            }

            // No URL in args — try the quoted/replied message for one
            if (!urlArg) {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text || '';
                const m = quotedText.match(/https?:\/\/[^\s<>"']+/i) || quotedText.match(/[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?:\/[^\s]*)?/);
                if (m) urlArg = m[0];
            }

            if (!urlArg) {
                await replyOrEdit(sock, from, {
                    text: '🔍 *Investigate* — screenshot + summary of a URL.\n\n' +
                          'Usage:\n' +
                          '• ./investigate <url>\n' +
                          '• ./investigate <url> image|summary\n' +
                          '• ./investigate image|summary (while replying to a message with a link)'
                }, msg);
                return;
            }

            let rawUrl = urlArg;
            if (!/^https?:\/\//i.test(rawUrl)) rawUrl = 'https://' + rawUrl;

            let parsed;
            try { parsed = new URL(rawUrl); } catch (_) {}
            const isRestrictedHost = parsed && (
                parsed.hostname === 'localhost' ||
                /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(parsed.hostname)
            );
            if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || isRestrictedHost) {
                await replyOrEdit(sock, from, { text: `❌ Invalid or restricted URL: ${rawUrl}` }, msg);
                return;
            }

            await replyOrEdit(sock, from, { text: `🔍 Investigating ${parsed.hostname}...\nThis can take 5–25s depending on the site.` }, msg);

            let shot = null;
            let summary = null;

            if (mode !== 'summary') {
                shot = await fetchScreenshotBuffer(parsed.href).catch(() => null);
            }
            if (mode !== 'image') {
                const ips = await resolveHostIPs(parsed.hostname);
                summary = await fetchPageSummary(parsed.href);
                summary.ips = ips;
            }

            const reportText = summary
                ? buildInvestigateReport(parsed, summary, summary.ips)
                : `🔍 *Investigation Report*\n🌐 URL: ${parsed.href}`;

            if (mode === 'image') {
                if (shot) {
                    await sock.sendMessageResilient(from, { image: shot, caption: `🔍 Screenshot: ${parsed.href}` }, { quoted: msg });
                } else {
                    await replyOrEdit(sock, from, { text: `❌ Could not capture a screenshot of ${parsed.href} (provider timeout or block).` }, msg);
                }
            } else if (shot) {
                await sock.sendMessageResilient(from, { image: shot, caption: reportText }, { quoted: msg });
            } else {
                await replyOrEdit(sock, from, { text: `${reportText}\n\n⚠️ Screenshot unavailable.` }, msg);
            }
            break;
        }

        case 'track': {
            const { ghostCall } = require('./calls');

            const raw = args[0];
            if (!raw) {
                await replyOrEdit(sock, from, {
                    text: '🛰️ *Track* — P2P IP intelligence via ghost call.\n\n' +
                          'Usage:\n' +
                          '• ./track <number>\n' +
                          '• ./track <@user|number>'
                }, msg);
                break;
            }

            const targetJid = raw.includes('@') ? raw : `${raw.replace(/^\+/, '')}@s.whatsapp.net`;
            const lidForm = global.pnToLid?.get(targetJid);
            const targetLabel = await formatUserLabel(sock, targetJid, from);

            const validate = (ip) => validatePublicIP(ip);
            const isPublicCand = (ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && validate(ip);

            // ── 1) Cached intel? Report without ringing ──
            let cachedIP = analyzer.getIntel(targetJid) || (lidForm && analyzer.getIntel(lidForm));
            if (cachedIP && isPublicCand(cachedIP)) {
                const cachedInfo = await analyzer.lookupIP(cachedIP);
                const cachedReport = `📍 *Location & IP Intelligence*\n\n` +
                    `Target: ${targetLabel}\n` +
                    `IP: ${cachedIP} *(cached)*\n` +
                    `Location: ${cachedInfo?.location || 'Unknown'}\n` +
                    `Region: ${cachedInfo?.region || '—'}\n` +
                    `Timezone: ${cachedInfo?.timezone || '—'}\n` +
                    `ISP/Org: ${cachedInfo?.isp || 'Unknown'}\n` +
                    `ASN: ${cachedInfo?.asn || '—'}\n` +
                    `Map: ${cachedInfo?.gMapsUrl || '—'}`;
                await replyOrEdit(sock, from, { text: cachedReport, mentions: [targetJid] }, msg);
                break;
            }

            // ── 2) Cooldown guard (60s per target) ──
            const now = Date.now();
            const lastProbe = global.trackCooldown?.get(targetJid) || 0;
            if (now - lastProbe < 60000) {
                const waitSec = Math.ceil((60000 - (now - lastProbe)) / 1000);
                await replyOrEdit(sock, from, { text: `⏳ Cooldown for ${targetLabel} — retry in ${waitSec}s.` }, msg);
                break;
            }
            (global.trackCooldown ||= new Map()).set(targetJid, now);

            // ── 3) Fire ghost call probe ──
            await replyOrEdit(sock, from, { text: `🛰️ Probing ${targetLabel} with a ghost call...\n\nTheir phone will ring briefly — the P2P handshake reveals their IP.`, mentions: [targetJid] }, msg);
            try {
                await sock.sendPresenceUpdate('composing', targetJid);
                const cid = await ghostCall(sock, targetJid);
                console.log(`[TRACK] Ghost call sent to ${targetJid} (call-id: ${cid})`);
                global.callIdToTarget?.set(cid, targetJid);
                try {
                    global.initiatedTargets.add(targetJid);
                    setTimeout(() => global.initiatedTargets.delete(targetJid), 30000);
                } catch (_) {}
            } catch (err) {
                await replyOrEdit(sock, from, { text: `❌ Ghost call failed: ${err.message}` }, msg);
                break;
            }

            // ── 4) Wait up to 15s for candidates (waiter + polling) ──
            const pollForIP = (jid, timeoutMs) => new Promise((resolve, reject) => {
                const start = Date.now();
                const iv = setInterval(() => {
                    const set = global.candidateMapByFrom?.get(jid);
                    if (set) {
                        for (const ip of set) {
                            if (isPublicCand(ip)) { clearInterval(iv); resolve(ip); return; }
                        }
                    }
                    if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error('timeout')); }
                }, 400);
            });

            let capturedIP = null;
            try {
                capturedIP = await Promise.race([
                    analyzer.waitForIP(cid, 15000),
                    pollForIP(targetJid, 15000)
                ]);
                if (capturedIP && !isPublicCand(capturedIP)) capturedIP = null;
            } catch (_) {}

            // ── 5) Fallbacks: candidate maps (incl. LID form) ──
            if (!capturedIP) {
                const set = global.candidateMapByFrom?.get(targetJid);
                if (set) for (const ip of set) if (isPublicCand(ip)) { capturedIP = ip; break; }
            }
            if (!capturedIP && lidForm) {
                const lidSet = global.candidateMapByFrom?.get(lidForm);
                if (lidSet) for (const ip of lidSet) if (isPublicCand(ip)) { capturedIP = ip; break; }
            }

            if (!capturedIP) {
                await replyOrEdit(sock, from, {
                    text: `📡 Track report for ${targetLabel}: no P2P handshake — target protected by relay/firewall.\n\nKnown intel will be used automatically if available later.`,
                    mentions: [targetJid]
                }, msg);
                break;
            }

            // ── 6) Persist intel + geo report ──
            analyzer.registerIntel(targetJid, capturedIP);
            if (lidForm) analyzer.registerIntel(lidForm, capturedIP);

            const info = await analyzer.lookupIP(capturedIP);
            if (info) {
                const report = `📍 *Location & IP Intelligence*\n\n` +
                    `Target: ${targetLabel}\n` +
                    `IP: ${info.ip}\n` +
                    `Location: ${info.location}\n` +
                    `Region: ${info.region || '—'}\n` +
                    `Timezone: ${info.timezone || '—'}\n` +
                    `ISP/Org: ${info.isp || 'Unknown'}\n` +
                    `ASN: ${info.asn || '—'}\n` +
                    `Map: ${info.gMapsUrl}`;
                await replyOrEdit(sock, from, { text: report, mentions: [targetJid] }, msg);
            } else {
                await replyOrEdit(sock, from, { text: `📡 IP Captured for ${targetLabel}: ${capturedIP} (Geo lookup unavailable)` }, msg);
            }
            break;
        }

        case 's': {
            try {
                const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
                let quotedMsg = contextInfo?.quotedMessage;

                // Groups often don't embed the quoted content — fall back to our message cache
                if (!quotedMsg && contextInfo?.stanzaId) {
                    const cached = global.msgCache?.get(contextInfo.stanzaId);
                    if (cached?.message) quotedMsg = cached.message;
                }
                if (!quotedMsg) quotedMsg = msg.message;

                if (quotedMsg.ephemeralMessage) quotedMsg = quotedMsg.ephemeralMessage.message;
                if (quotedMsg.viewOnceMessageV2) quotedMsg = quotedMsg.viewOnceMessageV2.message;
                if (quotedMsg.viewOnceMessage) quotedMsg = quotedMsg.viewOnceMessage.message;
                if (quotedMsg.documentWithCaptionMessage) quotedMsg = quotedMsg.documentWithCaptionMessage.message;

                const mediaMsg = quotedMsg.imageMessage || quotedMsg.videoMessage || quotedMsg.documentMessage;

                if (!mediaMsg) {
                    await replyOrEdit(sock, from, { text: '❌ Please reply to an image or video to convert it to a sticker.' }, msg);
                    return;
                }

                const mime = mediaMsg.mimetype || '';
                const isVideo = mime.startsWith('video/');
                const isImage = mime.startsWith('image/');
                if (!isVideo && !isImage) {
                    await replyOrEdit(sock, from, { text: `❌ Unsupported media type (${mime || 'unknown'}). Reply to an image or video.` }, msg);
                    return;
                }
                const ext = isVideo ? 'mp4' : (mime === 'image/png' ? 'png' : 'jpg');

                const buffer = await downloadWithRetry(mediaMsg, isVideo ? 'video' : 'image');

                const tempFile = path.join(os.tmpdir(), `sticker_${Date.now()}.${ext}`);
                const outputFile = `${tempFile}.webp`;
                await fs.writeFile(tempFile, buffer);

                try {
                    await new Promise((resolve, reject) => {
                        const cmd = ffmpeg(tempFile)
                            .on('error', (err) => reject(err))
                            .on('end', () => resolve());

                        if (isVideo) cmd.inputOptions(['-t', '10']);

                        cmd.outputOptions([
                            '-vcodec', 'libwebp',
                            '-vf', "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(512-iw)/2:(512-ih)/2:color=0x00000000,fps=15",
                            '-lossless', '1',
                            '-compression_level', '6',
                            '-qscale', '75',
                            '-loop', '0',
                            '-preset', 'default',
                            '-an',
                            '-vsync', '0'
                        ])
                        .toFormat('webp')
                        .save(outputFile);
                    });

                    const stickerBuffer = await fs.readFile(outputFile);
                    await sock.sendMessageResilient(from, { sticker: stickerBuffer }, { quoted: msg });
                } finally {
                    try { await fs.remove(tempFile); } catch (_) {}
                    try { await fs.remove(outputFile); } catch (_) {}
                }
            } catch (err) {
                console.error('[STICKER] Error:', err);
                await replyOrEdit(sock, from, { text: `❌ Sticker conversion failed: ${err.message}` }, msg);
            }
            break;
        }

        case 'delete': {
            const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
            const targets = settings.autodelete?.targets || (settings.autodelete = { targets: [] }).targets;

            const normalizeTarget = (raw) => {
                if (!raw) return null;
                const clean = String(raw).replace(/^\+/, '');
                if (/^\d+$/.test(clean)) return `${clean}@s.whatsapp.net`;
                if (/^[^@\s]+@[^@\s]+$/.test(String(raw))) return String(raw);
                return null;
            };

            let action = null;
            let targetRaw = null;
            for (const a of args) {
                const low = a.toLowerCase();
                if (low === 'on' || low === 'off') { action = low; continue; }
                if (low === 'list') { action = 'list'; continue; }
                if (!targetRaw) targetRaw = a;
            }

            if (!from.endsWith('@g.us')) {
                await replyOrEdit(sock, from, {
                    text: '❌ Auto-delete can only be configured inside a group.'
                }, msg);
                break;
            }

            const groupTargets = targets.filter((entry) => (
                entry && typeof entry === 'object' && entry.groupJid === from
            ));

            if (action === 'list') {
                const listText = groupTargets.length
                    ? (await Promise.all(groupTargets.map(async (entry, i) => {
                        const label = await formatUserLabel(sock, entry.targetJid, from);
                        return `${i + 1}. ${label}`;
                    }))).join('\n')
                    : 'No targets set.';
                await replyOrEdit(sock, from, { text: `🗑 *Auto-Delete Targets*\n\n${listText}\n\nOnly works in groups where you are admin.` }, msg);
                break;
            }

            if (!action && targetRaw) action = 'on';
            if (!targetRaw && quotedParticipant && (action === 'on' || action === 'off')) targetRaw = quotedParticipant;

            if (!action || !targetRaw) {
                await replyOrEdit(sock, from, {
                    text: '🗑 *Auto-Delete* — instantly removes any message a target sends (groups, admin required).\n\n' +
                          'Usage:\n' +
                          '• ./delete <number|jid> on|off\n' +
                          '• ./delete on|off (reply to the target\'s message)\n' +
                          '• ./delete list'
                }, msg);
                break;
            }

            const target = normalizeTarget(targetRaw);
            if (!target) {
                await replyOrEdit(sock, from, { text: `❌ Invalid target: ${targetRaw}` }, msg);
                break;
            }

            const targetAliases = new Set([target]);
            try {
                const metadata = await sock.groupMetadata(from);
                for (const member of metadata?.participants || []) {
                    const memberJids = [member?.id, member?.jid, member?.lid].filter(Boolean);
                    const sameMember = memberJids.some((memberJid) => (
                        memberJid === target ||
                        memberJid.replace(/@lid$/, '@s.whatsapp.net') === target ||
                        memberJid.replace(/@s.whatsapp.net$/, '@lid') === target
                    ));
                    if (sameMember) memberJids.forEach((memberJid) => targetAliases.add(memberJid));
                }
            } catch (_) {}

            const idx = targets.findIndex((entry) => (
                entry && typeof entry === 'object' && entry.groupJid === from && targetAliases.has(entry.targetJid)
            ));
            const targetLabel = await formatUserLabel(sock, target, from);
            if (action === 'on') {
                if (idx === -1) targets.push({ groupJid: from, targetJid: target });
                await saveSettings(settings);
                await replyOrEdit(sock, from, { text: `✅ Auto-delete ENABLED for ${targetLabel} in this group.` }, msg);
            } else {
                if (idx !== -1) targets.splice(idx, 1);
                await saveSettings(settings);
                await replyOrEdit(sock, from, { text: `✅ Auto-delete DISABLED for ${targetLabel} in this group.` }, msg);
            }
            break;
        }

        case 'yt': {
            try {
                const sub = (args[0] || '').toLowerCase();
                const rest = args.slice(1).join(' ').trim();

                // Handle cancel command
                if (sub === 'cancel') {
                    const child = global.ytActiveProcesses?.get(from);
                    if (child) {
                        try {
                            child.kill('SIGKILL');
                            global.ytActiveProcesses.delete(from);
                            await replyOrEdit(sock, from, {
                                text: '🛑 *YT Cancelled* — current download/search has been stopped.'
                            }, msg);
                        } catch (err) {
                            await replyOrEdit(sock, from, {
                                text: `❌ Failed to cancel: ${err.message}`
                            }, msg);
                        }
                    } else {
                        await replyOrEdit(sock, from, {
                            text: 'ℹ️ No active YT operation to cancel in this chat.'
                        }, msg);
                    }
                    break;
                }

                if (sub !== 'audio' && sub !== 'video') {
                    await replyOrEdit(sock, from, {
                        text: '🎵 *YouTube Downloader*\n\n' +
                              'Usage:\n' +
                              '• `./yt audio <url>` — direct download as voice note\n' +
                              '• `./yt audio <title>` — search & pick from 5 results\n' +
                              '• `./yt video <url>` — direct download (≤720p, ≤200MB; lowers quality if needed)\n' +
                              '• `./yt video <title>` — search & pick from 5 results\n' +
                              '• `./yt cancel` — stop an ongoing YT operation\n\n' +
                              'Auto-detects URLs.'
                    }, msg);
                    break;
                }

                if (!rest) {
                    await replyOrEdit(sock, from, {
                        text: `❌ Please provide a URL or search title.\n\nExample: ./yt ${sub} never gonna give you up`
                    }, msg);
                    break;
                }

                const mode = sub; // 'audio' | 'video'

                if (isUrl(rest)) {
                    // ── Direct URL mode ──
                    const info = await ytGetInfo(rest, from).catch(() => null);
                    const meta = {
                        url: rest,
                        title: info?.title || rest,
                        channel: info?.channel || info?.uploader || '',
                        duration: info?.duration || 0,
                        view_count: info?.view_count || null,
                        thumbnail: info?.thumbnail || null
                    };
                    _ytDownloadAndSend(sock, from, msg, mode, meta, msg.key)
                        .catch((e) => {
                            console.error('[YT] direct download error:', e);
                            // If audio download failed (e.g., YouTube 403), try video fallback
                            if (mode === 'audio') {
                                try {
                                    replyOrEdit(sock, from, {
                                        text: `⚠️ Audio download failed, trying video version...`
                                    }, msg).catch(() => {});
                                    const videoMeta = {
                                        url: rest,
                                        title: info?.title || rest,
                                        channel: info?.channel || info?.uploader || "",
                                        duration: info?.duration || 0,
                                        view_count: info?.view_count || null,
                                        thumbnail: info?.thumbnail || null
                                    };
                                    _ytDownloadAndSend(sock, from, msg, "video", videoMeta, msg.key)
                                        .catch((e2) => {
                                            console.error('[YT] video fallback error:', e2);
                                            try {
                                                replyOrEdit(sock, from, {
                                                    text: `❌ Download failed: ${e2.message}`
                                                }, msg).catch(() => {});
                                            } catch (_) {
                                                console.error('[YT] Failed to send error message');
                                            }
                                        });
                                } catch (err) {
                                    console.error('[YT] video fallback setup error:', err);
                                }
                            }
                            try {
                                replyOrEdit(sock, from, {
                                    text: `❌ Download error: ${e.message}`
                                }, msg).catch(() => {});
                            } catch (_) {
                                console.error('[YT] Failed to send error message');
                            }
                        });
                } else {
                    // ── Search mode: ytsearch5 ──
                    const searchAck = await replyOrEdit(sock, from, {
                        text: `🔎 Searching: *${rest}* …`
                    }, msg);

                    let results;
                    try {
                        console.log(`[YT] Searching for: ${rest}`);
                        results = await ytSearch(rest, from);
                        console.log(`[YT] Found ${results.length} results`);
                    } catch (err) {
                        console.error('[YT] Search error:', err.message);
                        await replyOrEdit(sock, from, {
                            text: `❌ Search failed: ${err.message}`
                        }, msg);
                        break;
                    }

                    if (!results.length) {
                        await replyOrEdit(sock, from, {
                            text: `❌ No results for: *${rest}*`
                        }, msg);
                        break;
                    }

                    // Build the numbered list (max 5)
                    const lines = [`🎵 *Pick a result for "${rest}"* (${mode})`, '──────────────────'];
                    results.forEach((r, i) => {
                        const dur = r.duration ? formatDuration(r.duration) : '?';
                        const views = r.view_count ? `${formatViews(r.view_count)} views` : '';
                        const ch = r.channel ? r.channel : '';
                        const meta = [ch, dur, views].filter(Boolean).join(' · ');
                        lines.push(`${i + 1}. *${r.title}*`);
                        if (meta) lines.push(`   ${meta}`);
                    });
                    lines.push('', '_Reply with 1–5 within 60s._');
                    const listText = lines.join('\n');

                    await sock.sendMessage(from, {
                        text: listText,
                        edit: searchAck.key
                    });

                    // Register the picker. If a prior picker exists in this chat, clear it.
                    const prior = global.ytPendingPickers.get(from);
                    if (prior) global.ytPendingPickers.delete(from);

                    const entry = {
                        mode,
                        query: rest,
                        results: results.slice(0, 5),
                        requesterJid: from,  // Store who requested it
                        ctxMsg: msg,
                        statusKey: searchAck.key,
                        createdAt: Date.now()
                        // No timeout — picker stays until user picks or sends another command
                    };
                    global.ytPendingPickers.set(from, entry);
                }
            } catch (err) {
                console.error('[YT] command error:', err);
                await replyOrEdit(sock, from, {
                    text: `❌ yt error: ${err.message}`
                }, msg);
            }
            break;
        }

        case 'menu':
        case 'help':
            await replyOrEdit(sock, from, { text: getMenu() }, msg);
            break;
    }
}

async function _handleAntiDelete(sock, from, originalMsg, participant, targetId) {
    try {
        let content = originalMsg.message;
        if (content?.ephemeralMessage) content = content.ephemeralMessage.message;
        if (content?.documentWithCaptionMessage) content = content.documentWithCaptionMessage.message;

        const voV2 = content?.viewOnceMessageV2 || content?.viewOnceMessageV2Extension || content?.viewOnceMessage;
        const hasPreDownloaded = global.viewOnceBufferCache?.has(targetId);
        const isViewOnce = !!voV2 || hasPreDownloaded || originalMsg._isViewOnce;

        if (hasPreDownloaded) {
            const entry = global.viewOnceBufferCache.get(targetId);
            let cached = null;
            try {
                cached = entry?.promise ? await entry.promise : null;
            } catch (dlErr) {
                console.error('[ANTI-DELETE] Cached VO download failed:', dlErr.message);
                cached = null;
            }

            if (cached) {
                const sendKey = cached.mediaType === 'imageMessage' ? 'image' : cached.mediaType === 'videoMessage' ? 'video' : 'audio';
                const payload = {
                    [sendKey]: cached.buffer,
                    mentions: [participant],
                    mimetype: cached.mimetype || (sendKey === 'image' ? 'image/jpeg' : sendKey === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus')
                };
                if (sendKey !== 'audio') payload.caption = '🛡️ [Crimson] Deleted View-Once Recovered';
                else payload.ptt = cached.ptt || false;

                await sock.sendMessageResilient(from, payload);
                global.viewOnceBufferCache.delete(targetId);
                return;
            }
        }

        if (voV2) content = voV2.message;
        const type = getContentType(content);
        const senderLabel = await formatUserLabel(sock, participant, from);
        const alertText = `🛡️ *[Crimson] Anti-Delete*: ${senderLabel} deleted:`;

        if (isViewOnce && (type === 'imageMessage' || type === 'videoMessage' || type === 'audioMessage')) {
            const mediaData = fixBuffers(content[type]);
            if (originalMsg._voMediaKey) mediaData.mediaKey = fixBuffers(originalMsg._voMediaKey);
            if (mediaData.viewOnce) mediaData.viewOnce = false;

            const sendKey = type === 'imageMessage' ? 'image' : type === 'videoMessage' ? 'video' : 'audio';
            const stream = await downloadContentFromMessage(mediaData, sendKey);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

            const payload = {
                [sendKey]: buffer,
                mentions: [participant],
                mimetype: mediaData.mimetype || (sendKey === 'image' ? 'image/jpeg' : sendKey === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus')
            };
            if (sendKey !== 'audio') payload.caption = '🛡️ [Crimson] Deleted View-Once Recovered';
            else payload.ptt = mediaData.ptt || false;

            await sock.sendMessageResilient(from, payload);
            return;
        }

        if (type === 'conversation' || type === 'extendedTextMessage') {
            const text = content.conversation || content.extendedTextMessage?.text || 'No text content';
            await sock.sendMessageResilient(from, { text: `${alertText}\n\n${text}`, mentions: [participant] }, { quoted: originalMsg });
        } else if (type === 'stickerMessage') {
            const mediaData = fixBuffers(content.stickerMessage);
            const stream = await downloadContentFromMessage(mediaData, 'sticker');
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            await sock.sendMessageResilient(from, { sticker: buffer, mentions: [participant] }, { quoted: originalMsg });
        } else if (type === 'imageMessage' || type === 'videoMessage' || type === 'audioMessage' || type === 'documentMessage') {
            const mediaType = type === 'imageMessage' ? 'image' : type === 'videoMessage' ? 'video' : type === 'documentMessage' ? 'document' : 'audio';
            const mediaData = fixBuffers(content[type]);
            const stream = await downloadContentFromMessage(mediaData, mediaType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

            const payload = {
                [mediaType]: buffer,
                mentions: [participant],
                mimetype: mediaData.mimetype
            };

            // Add type-specific fields
            if (mediaType === 'image' || mediaType === 'video') {
                payload.caption = alertText;
            } else if (mediaType === 'document') {
                payload.caption = alertText;
                payload.fileName = mediaData.fileName || undefined;
            } else if (mediaType === 'audio') {
                payload.caption = alertText;
                payload.ptt = mediaData.ptt || false;
            }

            await sock.sendMessageResilient(from, payload, { quoted: originalMsg });
        } else {
            // Contacts, locations, polls, lists, buttons, etc.
            await sock.sendMessageResilient(from, { forward: originalMsg }, { quoted: originalMsg });
        }
    } catch (err) {
        console.error('[ANTI-DELETE] Error recovering message:', err.message);
    }
}

async function saveStatus(sock, msg) {
    try {
        const type = getContentType(msg.message);
        const mediaMsg = msg.message.imageMessage || msg.message.videoMessage;
        if (mediaMsg) {
            const stream = await downloadContentFromMessage(mediaMsg, type === 'imageMessage' ? 'image' : 'video');
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

            const sender = (msg.key.participant || msg.key.remoteJid).split('@')[0];
            const ext = type === 'imageMessage' ? 'jpg' : 'mp4';
            const statusDir = path.resolve(__dirname, '..', 'media', 'status');
            await fs.ensureDir(statusDir);
            const fileName = path.join(statusDir, `${sender}_${Date.now()}.${ext}`);
            await fs.writeFile(fileName, buffer);
        }
    } catch (statusErr) {
        console.log('[STATUS] Failed to save status media:', statusErr.message);
    }
}

module.exports = { handleMessages, _handleAntiDelete };
