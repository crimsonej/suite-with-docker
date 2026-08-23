// ── DNS reliability patch (must run before net.js loads) ──
// The system resolver (resolv.conf) is flaky on this network and throws
// EAI_AGAIN during WebSocket connects. Route all socket lookups through
// c-ares using the local router + public DNS, verified 8/8 reliable.
const dnsMod = require('dns');
const { Resolver } = require('dns').promises;
const _origLookup = dnsMod.lookup;
const _dnsServers = process.env.DNS_SERVERS ? process.env.DNS_SERVERS.split(',') : ['192.168.1.1', '8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1'];
const _reliableResolver = new Resolver();
try { _reliableResolver.setServers(_dnsServers); } catch (_) {}
dnsMod.lookup = function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof options === 'number') { options = { family: options }; }
    const all = !!(options && options.all);
    const family = options && options.family;
    const query = family === 6
        ? _reliableResolver.resolve6(hostname).catch(() => _reliableResolver.resolve4(hostname))
        : _reliableResolver.resolve4(hostname);
    query.then(ips => {
        // Determine actual address family from resolved IP(s)
        const getActualFamily = (ip) => {
            // Simple check: IPv6 addresses contain ':', IPv4 addresses do not
            // This is not perfect for all IPv6 formats but works for typical cases
            return ip.includes(':') ? 6 : 4;
        };

        if (all) {
            const mapped = ips.map(ip => ({
                address: ip,
                family: getActualFamily(ip)
            }));
            return callback(null, mapped);
        }
        if (ips && ips.length > 0) {
            const actualFamily = getActualFamily(ips[0]);
            callback(null, ips[0], actualFamily);
        } else {
            callback(new Error('No IP addresses resolved'), null, null);
        }
    }).catch(err => {
        if (all) return callback(err);
        callback(err);
    });
};

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    getContentType,
    downloadContentFromMessage,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs-extra');
const path = require('path');
const dns = require('dns').promises;
const qrcode = require('qrcode-terminal');
const { handleMessages, _handleAntiDelete } = require('./lib/handler');
const analyzer = require('./lib/analyzer');
const axios = require('axios');
const { getSettings, saveSettings } = require('./lib/settings');
const { getVault } = require('./lib/vault');
const { logMessage, resolveName, pnOf } = require('./lib/logger');

const AUTH_FOLDER = path.resolve(__dirname, 'session_auth');

global.botStartTime = Math.floor(Date.now() / 1000);
global.lastMessageWithIP = null;
global.msgCache = new Map();
global.viewOnceBufferCache = new Map();

// Candidate maps for P2P handshake tracking
global.candidateMapByCallId = new Map();
global.candidateMapByFrom = new Map();
global.initiatedTargets = new Set();
global.callIdToTarget = new Map();
global.trackCooldown = new Map();

// LID ↔ phone-number mapping learned from chats.phoneNumberShare events
global.lidToPn = new Map();
global.pnToLid = new Map();

// Pending YouTube picker state: Map<fromJid, { mode, results, searchMessageKey, ctxMsg, timeout, createdAt }>
global.ytPendingPickers = new Map();

// Track when the current socket connection was established (for filtering old messages)
global.connectionTime = Date.now();

// Cache size limiter for memory protection (max 3000 messages)
const MAX_MSG_CACHE_SIZE = 3000;
function safeCacheMessage(id, msg) {
    if (global.msgCache.size >= MAX_MSG_CACHE_SIZE) {
        const firstKey = global.msgCache.keys().next().value;
        global.msgCache.delete(firstKey);
    }
    global.msgCache.set(id, msg);
}

// Shared DNS resolver using verified-reliable servers
const sharedResolver = new Resolver();
const dnsServers = _dnsServers;
sharedResolver.setServers(dnsServers);

let _isConnecting = false;
let isConnected = false;
let _retryCount = 0;
const MAX_RETRIES = 15;
let sock = null;

function isBadMacError(err) {
    const msg = (err?.message || '').toLowerCase();
    return msg.includes('bad mac') ||
           msg.includes('decrypt') ||
           msg.includes('failed to decrypt') ||
           msg.includes('libsignal') ||
           msg.includes('no sessions') ||
           msg.includes('sessionerror') ||
           msg.includes('session error');
}

async function cleanupSocket() {
    if (!sock) return;
    try { sock.ev.removeAllListeners(); } catch (_) {}
    try { sock.ws?.terminate?.() || sock.ws?.close?.(); } catch (_) {}
    try { sock.end?.(); } catch (_) {}
    sock = null;
}

async function handleBadMacError(err) {
    console.error('[SECURITY] Bad MAC / decryption failure detected:', err.message);
    console.error('[SECURITY] Clearing session state due to cryptographic error...');
    await cleanupSocket();
    await nukeSession(); // Clear session state to force fresh QR scan
    _retryCount = 0;
    setTimeout(startSuite, 3000);
}

function getReconnectDelay() {
    return Math.min(8000 * Math.pow(2, _retryCount), 120000);  // Increased base delay and max cap
}

async function waitForDNS(hostname, maxAttempts = 10) {
    for (let i = 1; i <= maxAttempts; i++) {
        try {
            const ips = await sharedResolver.resolve4(hostname);
            if (ips && ips.length) {
                console.log(`[DNS] ✓ ${hostname} resolved to ${ips[0]}`);
                return true;
            }
        } catch (err) {
            try {
                await dns.lookup(hostname);
                return true;
            } catch (_) {}
        }
        if (i < maxAttempts) await new Promise(r => setTimeout(r, 5000));
    }
    return false;
}

async function nukeSession() {
    console.log('[SESSION] Logged out — clearing session for fresh QR...');
    try { await fs.remove(AUTH_FOLDER); } catch (_) {}
}

async function autoDeleteIfTarget(sock, msg, settings) {
    try {
        const from = msg.key.remoteJid;
        const participant = msg.key.participant || '';
        if (!from.endsWith('@g.us') || !participant || msg.key.fromMe) return;

        const targets = settings.autodelete?.targets || [];
        if (!targets.length) return;

        const digitsOf = (j) => (j || '').replace(/[^\d]/g, '');
        const pn = participant.endsWith('@lid') ? (global.lidToPn?.get(participant) || '') : participant;

        const groupTargets = targets.filter((entry) => (
            entry && typeof entry === 'object' && entry.groupJid === from
        ));

        let match = groupTargets.some(entry => entry.targetJid === participant);
        if (!match && pn) {
            const pDigits = digitsOf(pn);
            match = groupTargets.some(entry => digitsOf(entry.targetJid) === pDigits);
        }

        // Group messages may use a LID even when ./delete was configured
        // with the member's phone JID. Resolve the member from group metadata
        // so auto-delete does not depend on a prior phoneNumberShare event.
        if (!match) {
            try {
                const metadata = await sock.groupMetadata(from);
                const member = (metadata?.participants || []).find((entry) => (
                    entry?.id === participant ||
                    entry?.jid === participant ||
                    entry?.lid === participant
                ));
                const memberJids = [member?.id, member?.jid, member?.lid].filter(Boolean);
                match = groupTargets.some((target) => memberJids.some((memberJid) => (
                    target.targetJid === memberJid ||
                    digitsOf(target.targetJid) === digitsOf(memberJid)
                )));
            } catch (err) {
                console.log(`[AUTODEL] Could not resolve group participant: ${err.message}`);
            }
        }
        if (!match) return;

        try {
            await sock.sendMessage(from, {
                delete: { remoteJid: from, id: msg.key.id, participant, fromMe: false }
            });
            const senderName = await resolveName(sock, participant);
            const senderPhone = pnOf(participant);
            console.log(`[AUTODEL] Deleted message from ${senderName} (${senderPhone}) in ${from}`);
            const vaultJid = (await getVault()) || global.vault;
            if (vaultJid && vaultJid !== from) {
                await sock.sendMessage(vaultJid, {
                    text: `🗑 *Auto-Delete*: removed ${senderName} (${senderPhone})'s message from this group.`
                });
            }
        } catch (err) {
            console.log(`[AUTODEL] Delete failed for ${participant} in ${from} (admin rights required):`, err.message);
        }
    } catch (_) {}
}

function registerSocketEvents(sock) {
    if (!sock || !sock.ev) return;

    // ── Global error handler for Bad MAC and crypto failures ──
    sock.ev.on('error', async (err) => {
        if (isBadMacError(err)) {
            console.error('[ERROR] Socket-level Bad MAC detected, clearing session...');
            await handleBadMacError(err);
        }
    });

    // ── Connection lifecycle ──
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !isConnected) {
            console.clear();
            console.log('╬══════════════════════════════════════╬');
            console.log('║  Scan the QR code below to connect:  ║');
            console.log('╚══════════════════════════════════════╝');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            _retryCount   = 0;
            _isConnecting = false;
            isConnected   = true;
            global.vault  = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            global.connectionTime = Date.now();

            // Clear stale state from previous session to prevent old operations
            // from being affected by leftover cooldowns (but preserve ytPendingPickers
            // so users don't lose their search results if connection briefly flickers)
            // Also clear out any stale pickers that expired > 5min ago while offline
            const now = Date.now();
            for (const [from, picker] of global.ytPendingPickers?.entries() || []) {
                if (now - picker.createdAt > 5 * 60 * 1000) {
                    clearTimeout(picker.timeout);
                    global.ytPendingPickers.delete(from);
                }
            }
            if (global.trackCooldown) global.trackCooldown.clear();
            if (global.initiatedTargets) global.initiatedTargets.clear();
            if (global.callIdToTarget) global.callIdToTarget.clear();
            console.log('[STATE] Cleared stale cooldowns on reconnect (preserved active pickers).');

            const platform = process.env.TERMUX_VERSION ? 'Termux' : 'Linux/Parrot';
            console.log(`[SUCCESS] Crimson Suite is Live — Platform: ${platform}`);
            try { await sock.sendMessage(global.vault, { text: '🛡️ Suites Engine: Online. Vault operational.' }); } catch (_) {}
        }

        if (connection === 'close') {
            _isConnecting = false;
            isConnected   = false;
            const error = lastDisconnect?.error;
            const statusCode = error?.output?.statusCode || error?.data || (error instanceof Boom ? error.output.statusCode : 0);
            const msg = error?.message || '';

            if (statusCode === 515 || statusCode === DisconnectReason.restartRequired) {
                console.log('[CONN] Soft restart required (515). Reconnecting in 3s for filesystem flush...');
                setTimeout(startSuite, 3000);
                return;
            }

            console.log(`[CONN] Connection closed. Status: ${statusCode}, Message: ${msg}`);

            // Handle unauthorized or session conflict (often both are related)
            if (statusCode === 401 || statusCode === 440 || statusCode === DisconnectReason.loggedOut || (msg && msg.includes('conflict'))) {
                console.log('[CONN] 🔴 Session conflict/unauthorized (401/440). Clearing session for fresh QR...');
                await nukeSession();
                _retryCount = 0;
                setTimeout(startSuite, 3000);
                return;
            }

            if (_retryCount < MAX_RETRIES) {
                _retryCount++;
                const delay = getReconnectDelay();
                console.log(`[CONN] 🟡 Reconnecting in ${Math.ceil(delay / 1000)}s (attempt ${_retryCount}/${MAX_RETRIES})...`);
                setTimeout(startSuite, delay);
            } else {
                console.log('[CONN] 🔴 Max retries reached. Cooling down 5 minutes...');
                _retryCount = 0;
                setTimeout(startSuite, 300000);
            }
        }
    });

    // ── Message pipeline ──
    const processedMessages = new Set();
    sock.ev.removeAllListeners('messages.upsert');
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const tasks = messages
            .filter(msg => msg.message)
            .map(async (msg) => {
                if (processedMessages.has(msg.key.id)) return;
                processedMessages.add(msg.key.id);
                setTimeout(() => processedMessages.delete(msg.key.id), 5000);

                try {
                    const from = msg.key.remoteJid;

                    // ── Skip messages older than 2 minutes before connection ──
                    // This prevents re-processing of old commands when the service
                    // restarts or reconnects (Baileys delivers backlog messages)
                    const msgTimestamp = (msg.messageTimestamp || 0) * 1000;
                    const connTime = global.connectionTime || Date.now();
                    if (msgTimestamp && msgTimestamp < connTime - 120000) {
                        return;
                    }

                    // ── Auto-anchor home_jid to owner's first private-chat command ──
                    if (!from.endsWith('@g.us') && !msg.key.fromMe) {
                        const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                        if (body.startsWith('./')) {
                            try {
                                const s = await getSettings();
                                if (!s.home_jid) {
                                    s.home_jid = jidNormalizedUser(from);
                                    await saveSettings(s);
                                }
                            } catch (_) {}
                        }
                    }

                    logMessage(sock, msg).catch(() => {});

                    // ── Auto-delete (admin power: ./delete <target> on) ──
                    if (from.endsWith('@g.us') && !msg.key.fromMe && !msg.message.protocolMessage) {
                        const adSettings = await getSettings();
                        if (adSettings.suite_enabled !== false && adSettings.autodelete?.targets?.length) {
                            await autoDeleteIfTarget(sock, msg, adSettings).catch(() => {});
                        }
                    }

                    if (!msg.message.protocolMessage) {
                        try {
                            const cloned = JSON.parse(JSON.stringify(msg));
                            safeCacheMessage(msg.key.id, cloned);

                            let voMediaObj  = null;
                            let voMediaType = null;
                            const msgContent = msg.message;

                            const checkVO = (obj) => {
                                if (!obj) return null;
                                if (obj.viewOnceMessageV2)          return { wrapper: obj.viewOnceMessageV2 };
                                if (obj.viewOnceMessageV2Extension) return { wrapper: obj.viewOnceMessageV2Extension };
                                if (obj.viewOnceMessage)            return { wrapper: obj.viewOnceMessage };
                                return null;
                            };

                            const voInfo = checkVO(msgContent) || checkVO(msgContent?.ephemeralMessage?.message);

                            if (voInfo?.wrapper?.message) {
                                const inner = voInfo.wrapper.message;
                                voMediaType = inner.imageMessage ? 'imageMessage'
                                            : inner.videoMessage ? 'videoMessage'
                                            : inner.audioMessage ? 'audioMessage' : null;
                                if (voMediaType) voMediaObj = inner[voMediaType];
                            }

                            if (!voMediaObj) {
                                const c = msgContent?.ephemeralMessage?.message || msgContent;
                                if      (c?.imageMessage?.viewOnce) { voMediaObj = c.imageMessage; voMediaType = 'imageMessage'; }
                                else if (c?.videoMessage?.viewOnce) { voMediaObj = c.videoMessage; voMediaType = 'videoMessage'; }
                                else if (c?.audioMessage?.viewOnce) { voMediaObj = c.audioMessage; voMediaType = 'audioMessage'; }
                            }

                            if (voMediaObj && voMediaType) {
                                cloned._isViewOnce  = true;
                                cloned._voMediaType = voMediaType;
                                cloned._voMediaKey  = voMediaObj.mediaKey;
                                safeCacheMessage(msg.key.id, cloned);

                                const dlType = voMediaType === 'imageMessage' ? 'image' : voMediaType === 'videoMessage' ? 'video' : 'audio';
                                const downloadPromise = (async () => {
                                    const stream = await downloadContentFromMessage(voMediaObj, dlType);
                                    let buffer   = Buffer.from([]);
                                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                                    return { buffer, mediaType: voMediaType, mimetype: voMediaObj.mimetype, ptt: voMediaObj.ptt || false };
                                })();
                                global.viewOnceBufferCache.set(msg.key.id, { ts: Date.now(), promise: downloadPromise });
                            }
                        } catch (_) {
                            safeCacheMessage(msg.key.id, msg);
                        }
                    }

                    const protoType = msg.message?.protocolMessage?.type;
                    const isRevoke = protoType === 0 || protoType === 'REVOKE';

                    if (isRevoke) {
                        if (from === 'status@broadcast') return; // status deletions are normal — ignore

                        const targetId = msg.message.protocolMessage.key.id;
                        const originalMsg = global.msgCache.get(targetId);
                        if (!originalMsg || originalMsg.key.fromMe) return;

                        const settings   = await getSettings();
                        if (settings.suite_enabled === false) return;
                        const isGroup    = from.endsWith('@g.us');
                        const adSettings = settings.antidelete;
                        const shouldTrigger = adSettings.exceptions.hasOwnProperty(from)
                            ? adSettings.exceptions[from]
                            : (isGroup ? adSettings.global_groups : adSettings.global_private);

                        if (!shouldTrigger) return;

                        const participant = originalMsg.key.participant || originalMsg.key.remoteJid || from;
                        await _handleAntiDelete(sock, from, originalMsg, participant, targetId);
                        return;
                    }

                    try {
                        if (msg.key.fromMe && from !== 'status@broadcast') {
                            const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                            if (body.startsWith('./')) {
                                await sock.sendPresenceUpdate('composing', from);
                                setTimeout(() => sock.sendPresenceUpdate('paused', from).catch(() => {}), 1500);
                            }
                        }
                    } catch (_) {}

                    try {
                        await handleMessages(sock, msg);
                    } catch (handlerErr) {
                        if (isBadMacError(handlerErr)) await handleBadMacError(handlerErr);
                    }
                } catch (msgErr) {
                    if (isBadMacError(msgErr)) await handleBadMacError(msgErr);
                }
            });

        await Promise.allSettled(tasks);
    });

    // ── Unified Call & WebRTC Candidate Handler ──
    sock.ev.on('call', async (calls) => {
        const callList = Array.isArray(calls) ? calls : [calls];

        for (const call of callList) {
            const { from, id, status, content } = call;
            console.log(`[CALL] Call ID: ${id} | Status: ${status} | From: ${from}`);
            
            if (content && Array.isArray(content)) {
                for (const stanza of content) {
                    if (stanza.tag === 'candidate' && stanza.attrs && stanza.attrs.ip) {
                        const ip = stanza.attrs.ip;
                        console.log(`[CALL] IP Candidate captured: ${ip}`);

                        // Candidate stanzas carry the real call-id under attrs
                        // 'call-id' (the WebRTC negotiation id). The outer call
                        // event's `id` is a different message tag, so the waiter
                        // registered with the real call-id from ghostCall() can
                        // only be woken by using the real call-id here.
                        const cid = stanza.attrs['call-id'] || id;

                        const callSet = global.candidateMapByCallId.get(cid) || new Set();
                        callSet.add(ip);
                        global.candidateMapByCallId.set(cid, callSet);

                        const fromSet = global.candidateMapByFrom.get(from) || new Set();
                        fromSet.add(ip);
                        global.candidateMapByFrom.set(from, fromSet);

                        // Wake any ./track waiter armed for this call id
                        analyzer.resolveIP(cid, ip);
                    }
                }
            }

            // Extract the real call-id from the offer content (WebRTC call ID)
            let callIdFromContent = null;
            if (content && Array.isArray(content)) {
                for (const stanza of content) {
                    if (stanza.tag === 'offer' && stanza.attrs && stanza.attrs['call-id']) {
                        callIdFromContent = stanza.attrs['call-id'];
                        break;
                    }
                }
            }
            const trackedTarget = global.callIdToTarget.get(callIdFromContent || id);
            if (status === 'offer') {
                if (global.initiatedTargets.has(from) || trackedTarget) {
                    call.isGhost = true;
                    global.initiatedTargets.delete(from);
                    if (callIdFromContent) {
                        global.callIdToTarget.delete(callIdFromContent);
                    } else {
                        global.callIdToTarget.delete(id);
                    }
                    console.log(`[CALL] Outgoing ghost call offer echo received, rejecting in 2s`);
                    setTimeout(async () => {
                        try { await sock.rejectCall(id, from); } catch (_) {}
                    }, 2000);
                }
            }
            if (status === 'terminate' || status === 'accept' || status === 'reject' || status === 'timeout') {
                if (callIdFromContent) {
                    global.callIdToTarget.delete(callIdFromContent);
                } else {
                    global.callIdToTarget.delete(id);
                }
            }
        }

        // ── Auto-track is always armed, regardless of ./suite state ──
        try {
            const analyzerFn = require('./lib/analyzer').analyzer;
            await analyzerFn(sock, callList);
        } catch (_) {}
    });
}

async function startSuite() {
    if (_isConnecting) return;
    _isConnecting = true;

    try {
        await waitForDNS('web.whatsapp.com', 3);
        const P = require('pino');
        const logger = P({ level: 'silent' });
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        const { version } = await fetchLatestBaileysVersion();

        await cleanupSocket();
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            version,
            logger,
            qrTimeout: 3600000,
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: false,
            msgRetryCounter: 5,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 5,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            browser: ['Suites', 'Chrome', '10.0.0'],
            transactionOpts: { maxCommitRetries: 5, delayBetweenTriesMs: 2000 }
        });

        // Define sendMessageResilient BEFORE registering socket events
        sock.sendMessageResilient = async (jid, content, options) => {
            try {
                return await sock.sendMessage(jid, content, options);
            } catch (err) {
                if (err?.output?.statusCode === 428) {
                    await new Promise(r => setTimeout(r, 2000));
                    return await sock.sendMessage(jid, content, options);
                }
                throw err;
            }
        };

        registerSocketEvents(sock);

        sock.ev.on('creds.update', saveCreds);

        // Learn LID ↔ phone-number mappings (used by auto-delete & track)
        sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
            if (!lid || !jid) return;
            global.lidToPn.set(lid, jid);
            global.pnToLid.set(jid, lid);
        });

        return sock;
    } catch (err) {
        _isConnecting = false;
        _retryCount++;
        console.error('[STARTUP] Suite initialization failed:', err?.stack || err?.message || err);
        setTimeout(startSuite, getReconnectDelay());
    }
}

process.on('uncaughtException', (err) => {
    if (err.message?.includes('Connection Failure') || err.message?.includes('noise') ||
        err.message?.includes('Bad MAC') || err.message?.includes('bad mac') ||
        err.message?.includes('decrypt') || err.message?.includes('libsignal')) {
        console.error('[UNCAUGHT] Cryptographic or connection error detected:', err.message);
        _isConnecting = false;
        // For cryptographic errors, we should clear session state
        if (err.message?.includes('Bad MAC') || err.message?.includes('bad mac') ||
            err.message?.includes('decrypt') || err.message?.includes('libsignal')) {
            console.error('[UNCAUGHT] Clearing session state due to cryptographic error...');
            nukeSession().catch(() => {}); // Don't await to avoid blocking
        }
        setTimeout(startSuite, 5000);
    }
});

process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(reason);
    if (err.message?.includes('Bad MAC') || err.message?.includes('bad mac') ||
        err.message?.includes('decrypt') || err.message?.includes('libsignal')) {
        console.error('[UNHANDLED REJECTION] Cryptographic error detected:', err.message);
        console.error('[UNHANDLED REJECTION] Clearing session state due to cryptographic error...');
        // For cryptographic errors, we should clear session state
        nukeSession().catch(() => {}); // Don't await to avoid blocking
        _isConnecting = false;
        setTimeout(startSuite, 5000);
    }
    // Note: We don't call startSuite here for non-cryptographic errors to avoid
    // potentially restarting on every unhandled promise rejection
});

// ── View-once buffer retention (30 min TTL, max 200 entries) ──
const VO_BUFFER_TTL_MS = 30 * 60 * 1000;
const MAX_VO_BUFFER_SIZE = 200;
function pruneViewOnceBuffer() {
    const now = Date.now();
    let removed = 0;
    for (const [id, entry] of global.viewOnceBufferCache) {
        if (!entry || !entry.ts || now - entry.ts > VO_BUFFER_TTL_MS) {
            global.viewOnceBufferCache.delete(id);
            removed++;
        }
    }
    while (global.viewOnceBufferCache.size > MAX_VO_BUFFER_SIZE) {
        const firstKey = global.viewOnceBufferCache.keys().next().value;
        global.viewOnceBufferCache.delete(firstKey);
        removed++;
    }
    if (removed > 0) console.log(`[VO] Pruned ${removed} stale view-once buffer(s).`);
}
pruneViewOnceBuffer();
setInterval(pruneViewOnceBuffer, 10 * 60 * 1000);

// ── Status media retention (keep last 7 days, prune daily) ──
const STATUS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
async function pruneStatusMedia() {
    try {
        const dir = path.resolve(__dirname, 'media', 'status');
        if (!await fs.pathExists(dir)) return;
        const now = Date.now();
        let removed = 0;
        for (const file of await fs.readdir(dir)) {
            const filePath = path.join(dir, file);
            const stat = await fs.stat(filePath).catch(() => null);
            if (stat && stat.isFile() && now - stat.mtimeMs > STATUS_RETENTION_MS) {
                await fs.remove(filePath).catch(() => {});
                removed++;
            }
        }
        if (removed > 0) console.log(`[STATUS] Pruned ${removed} status media file(s) older than 7 days.`);
    } catch (_) {}
}
pruneStatusMedia();
setInterval(pruneStatusMedia, 24 * 60 * 60 * 1000);

const shutdown = async (signal) => {
    console.log(`\n[SYSTEM] Received ${signal}. Shutting down Crimson Engine gracefully...`);
    await cleanupSocket();
    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('[DEBUG] Starting Crimson Engine...');
startSuite();

