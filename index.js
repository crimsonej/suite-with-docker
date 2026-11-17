// ── DNS reliability patch (must run before net.js loads) ──
// The system resolver (resolv.conf) is flaky on this network and throws
// EAI_AGAIN during WebSocket connects. Route all socket lookups through
// c-ares using the local router + public DNS, verified 8/8 reliable.
const dnsMod = require('dns');
const netMod = require('net');
const { Resolver } = require('dns').promises;
const _origLookup = dnsMod.lookup;
const _dnsServers = process.env.DNS_SERVERS ? process.env.DNS_SERVERS.split(',') : ['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1'];
const _reliableResolver = new Resolver();
try { _reliableResolver.setServers(_dnsServers); } catch (_) {}
dnsMod.lookup = function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof options === 'number') { options = { family: options }; }
    if (!hostname || netMod.isIP(hostname) || hostname === 'localhost') {
        return _origLookup.call(dnsMod, hostname, options, callback);
    }
    const all = !!(options && options.all);
    const family = options && options.family;
    const query = family === 6
        ? _reliableResolver.resolve6(hostname).catch(() => _reliableResolver.resolve4(hostname))
        : _reliableResolver.resolve4(hostname);
    query.then(ips => {
        const getActualFamily = (ip) => (ip.includes(':') ? 6 : 4);

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
            _origLookup.call(dnsMod, hostname, options, callback);
        }
    }).catch(() => {
        _origLookup.call(dnsMod, hostname, options, callback);
    });
};

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    getContentType,
    downloadContentFromMessage,
    jidNormalizedUser,
    Browsers
} = require('@whiskeysockets/baileys');

// ── Pairing-code login ──
// Set PAIRING_NUMBER (international format, digits only, e.g. 2348012345678) to
// log in with an 8-character code instead of scanning a QR. Use this wherever
// the log viewer can't render a QR (e.g. Railway's web logs).
const PAIRING_NUMBER = (() => {
    const digits = (process.env.PAIRING_NUMBER || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length < 8 || digits.length > 15) {
        console.error(`[PAIRING] PAIRING_NUMBER "${process.env.PAIRING_NUMBER}" is not a valid international number (8–15 digits, country code first). Falling back to QR.`);
        return '';
    }
    return digits;
})();
let _pairingRequestedFor = null; // socket instance we already asked a code for
const { Boom } = require('@hapi/boom');
const fs = require('fs-extra');
const path = require('path');
const dns = require('dns').promises;
const { printQR } = require('./lib/qr');
const { applyPresence, stopRefresh: stopPresenceRefresh } = require('./lib/presence');
const { handleMessages, _handleAntiDelete } = require('./lib/handler');
const { isAiMessage } = require('./lib/ai');
const axios = require('axios');
const { getSettings, saveSettings, updateSettings } = require('./lib/settings');
const { getVault } = require('./lib/vault');
const { logMessage, formatUserLabel, isSenderMe } = require('./lib/logger');

// ── Suppress noisy Baileys/libsignal session debug spam ──
// libsignal uses console.info("Closing session:", session), console.warn, etc.
// These flood Railway with 500+ logs/sec causing CPU starvation, rate-limit drops, and bot freezing
const _origConsoleLog = console.log;
const _origConsoleInfo = console.info;
const _origConsoleWarn = console.warn;
const _origConsoleError = console.error;
const _origConsoleDebug = console.debug;

const _noisePatterns = [
    /Closing session/i,
    /Opening session/i,
    /Removing old closed session/i,
    /Session already closed/i,
    /Session already open/i,
    /SessionEntry/,
    /Decrypted message with closed session/i,
    /Closing open session in favor of/i,
    /Migrating session to/i,
    /Got new sender key/i,
    /sender key not found/i,
    /Retrying.*signal/i,
    /session not found for/i,
    /No sessions/i,
    /ratchet step/i,
    /PreKeyMessage/i,
    /got prekey bundle/i,
    /Unhandled bucket type/i,
    /Failed to decrypt message with any known session/i,
    /Session error:/i,
    /\[Signal\]/i,
    /\[Noise\]/i
];

function _isNoisyLog(args) {
    if (!args || !args.length) return false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!a) continue;
        if (typeof a === 'string') {
            if (_noisePatterns.some(p => p.test(a))) return true;
        } else if (typeof a === 'object') {
            if (a.constructor?.name === 'SessionEntry' || a._chains || a.currentRatchet || a.pendingPreKey) {
                return true;
            }
            try {
                const s = typeof a.toString === 'function' ? a.toString() : '';
                if (s && _noisePatterns.some(p => p.test(s))) return true;
            } catch (_) {}
        }
    }
    return false;
}

console.log = function(...args) {
    if (_isNoisyLog(args)) return;
    _origConsoleLog.apply(console, args);
};
console.info = function(...args) {
    if (_isNoisyLog(args)) return;
    _origConsoleInfo.apply(console, args);
};
console.warn = function(...args) {
    if (_isNoisyLog(args)) return;
    _origConsoleWarn.apply(console, args);
};
console.error = function(...args) {
    if (_isNoisyLog(args)) return;
    _origConsoleError.apply(console, args);
};
console.debug = function(...args) {
    if (_isNoisyLog(args)) return;
    _origConsoleDebug.apply(console, args);
};

const AUTH_FOLDER = process.env.SESSION_DIR || process.env.AUTH_FOLDER || path.resolve(__dirname, 'session_auth');

global.botStartTime = Math.floor(Date.now() / 1000);
global.lastMessageWithIP = null;
global.msgCache = new Map();
global.viewOnceBufferCache = new Map();

// LID ↔ phone-number mapping learned from chats.phoneNumberShare events
global.lidToPn = new Map();
global.pnToLid = new Map();

// Pending YouTube picker state: Map<fromJid, { mode, results, searchMessageKey, ctxMsg, timeout, createdAt }>
global.ytPendingPickers = new Map();

// Track when the current socket connection was established (for filtering old messages)
global.connectionTime = Date.now();

// Cache size limiter for memory protection
const MAX_MSG_CACHE_SIZE = parseInt(process.env.MAX_MSG_CACHE_SIZE, 10) || 2000;
function safeCacheMessage(id, msg) {
    if (global.msgCache.size >= MAX_MSG_CACHE_SIZE) {
        const firstKey = global.msgCache.keys().next().value;
        global.msgCache.delete(firstKey);
    }
    global.msgCache.set(id, msg);
}

// In-memory retry counter cache to prevent decryption/MAC failures during re-keying
const msgRetryMap = new Map();
const msgRetryCounterCache = {
    get: (key) => msgRetryMap.get(key),
    set: (key, val) => {
        if (msgRetryMap.size > 2000) {
            const first = msgRetryMap.keys().next().value;
            msgRetryMap.delete(first);
        }
        msgRetryMap.set(key, val);
    },
    del: (key) => msgRetryMap.delete(key)
};

// Shared DNS resolver using verified-reliable servers
const sharedResolver = new Resolver();
const dnsServers = _dnsServers;
sharedResolver.setServers(dnsServers);

let _isConnecting = false;
let isConnected = false;
let _retryCount = 0;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES, 10) || 15;
let sock = null;

function getReconnectDelay() {
    return Math.min(1000 * Math.pow(2, Math.max(1, _retryCount)), 30000);
}

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
    stopPresenceRefresh();
    try { sock.ev.removeAllListeners(); } catch (_) {}
    try { sock.ws?.terminate?.() || sock.ws?.close?.(); } catch (_) {}
    try { sock.end?.(); } catch (_) {}
    sock = null;
}

async function handleBadMacError(err) {
    console.error('[SECURITY] Bad MAC / decryption failure detected:', err.message);
    console.error('[SECURITY] Preserving session state (Baileys will manage key retry).');
}

function getPlatformName() {
    if (process.env.TERMUX_VERSION || (process.env.PREFIX && process.env.PREFIX.includes('com.termux'))) {
        return 'Termux';
    }
    let osName = '';
    try {
        if (fs.existsSync('/etc/os-release')) {
            const content = fs.readFileSync('/etc/os-release', 'utf8');
            const match = content.match(/^PRETTY_NAME="?([^"\n]+)"?/m) || content.match(/^NAME="?([^"\n]+)"?/m);
            if (match) osName = match[1];
        }
    } catch (_) {}
    if (!osName) {
        osName = `${os.type()} ${os.arch()}`;
    }
    if (fs.existsSync('/.dockerenv')) {
        return `Docker (${osName})`;
    }
    return osName;
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
    delete process.env.SESSION_DATA;
    delete process.env.SESSION_BASE64;
    _hasSyncedSession = false;
    if (typeof deleteRailwaySessionVariable === 'function') {
        await deleteRailwaySessionVariable().catch(() => {});
    }
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
            const senderLabel = await formatUserLabel(sock, participant, from);
            const groupName = await resolveName(sock, from);
            console.log(`[AUTODEL] Deleted message from ${senderLabel} in ${groupName}`);
            const vaultJid = (await getVault()) || global.vault;
            if (vaultJid && vaultJid !== from) {
                await sock.sendMessage(vaultJid, {
                    text: `🗑 *Auto-Delete*: removed ${senderLabel}'s message in *${groupName}*.`
                });
            }
        } catch (err) {
            console.log(`[AUTODEL] Delete failed for ${participant} in ${from} (admin rights required):`, err.message);
        }
    } catch (_) {}
}

function isStickerMsg(msg) {
    if (!msg?.message) return false;
    const m = msg.message;
    if (m.stickerMessage) return true;
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message;
    if (inner?.stickerMessage) return true;
    return false;
}

async function autoDeleteIfSticker(sock, msg, settings) {
    try {
        const from = msg.key.remoteJid;
        const participant = msg.key.participant || (msg.key.fromMe ? '' : from);
        if (!from.endsWith('@g.us') || !participant || msg.key.fromMe) return;

        const stickerGroups = settings.autodelete?.sticker_groups || [];
        if (!stickerGroups.includes(from)) return;

        if (!isStickerMsg(msg)) return;

        try {
            await sock.sendMessage(from, {
                delete: { remoteJid: from, id: msg.key.id, participant, fromMe: false }
            });
            const senderLabel = await formatUserLabel(sock, participant, from);
            const groupName = await resolveName(sock, from);
            console.log(`[AUTODEL-STICKER] Deleted sticker from ${senderLabel} in ${groupName}`);
        } catch (err) {
            console.log(`[AUTODEL-STICKER] Delete failed in ${from} (admin rights required):`, err.message);
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

        if (qr && !isConnected && PAIRING_NUMBER && !sock.authState?.creds?.registered) {
            // One code per socket: WhatsApp keeps re-emitting `qr` refs, but the
            // pairing code stays valid for the life of this connection attempt.
            if (_pairingRequestedFor !== sock) {
                _pairingRequestedFor = sock;
                try {
                    const code = await sock.requestPairingCode(PAIRING_NUMBER);
                    const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
                    console.log('');
                    console.log('╔══════════════════════════════════════╗');
                    console.log(`║   PAIRING CODE:  ${pretty.padEnd(20)}║`);
                    console.log('╚══════════════════════════════════════╝');
                    console.log(`[PAIRING] For +${PAIRING_NUMBER}: WhatsApp → Linked devices → Link a device →`);
                    console.log('[PAIRING] "Link with phone number instead" → enter the code above.');
                } catch (err) {
                    _pairingRequestedFor = null;
                    console.error('[PAIRING] Could not request a pairing code:', err.message);
                }
            }
        } else if (qr && !isConnected) {
            // console.clear() is a no-op in non-TTY log viewers (Railway, docker logs),
            // so only use it on a real terminal.
            if (process.stdout.isTTY) console.clear();
            printQR(qr, [
                '╔══════════════════════════════════════╗',
                '║  Scan the QR code below to connect:  ║',
                '╚══════════════════════════════════════╝',
                'Not scanning? Restart with QR_MODE=large for a bigger code.'
            ].join('\n'));
        }

        if (connection === 'open') {
            _retryCount   = 0;
            _isConnecting = false;
            isConnected   = true;
            global.vault  = jidNormalizedUser(sock.user.id);
            global.connectionTime = Date.now();

            // Start the presence heartbeat for whichever mode is saved. For the
            // default (off) this keeps re-asserting 'unavailable' so the phone
            // keeps getting notifications even though the bot stays connected.
            getSettings().then((s) => applyPresence(sock, !!s.always_online)).catch(() => {});

            // Clear stale state from previous session to prevent old operations
            const now = Date.now();
            for (const [from, picker] of global.ytPendingPickers?.entries() || []) {
                if (now - picker.createdAt > 5 * 60 * 1000) {
                    clearTimeout(picker.timeout);
                    global.ytPendingPickers.delete(from);
                }
            }
            console.log('[STATE] Cleared stale cooldowns on reconnect (preserved active pickers).');

            const platform = getPlatformName();
            console.log(`[SUCCESS] Crimson Suite is Live — Platform: ${platform}`);
            try { await sock.sendMessage(global.vault, { text: '🛡️ Suites Engine: Online. Vault operational.' }); } catch (_) {}

            // Auto-sync session keys after initial scan if not already restored from environment
            if (!_hasSyncedSession) {
                setTimeout(async () => {
                    try {
                        await syncSessionAfterScan(sock);
                    } catch (err) {
                        console.error('[SESSION] Auto-sync error:', err.message);
                    }
                }, 4000);
            }
        }

        if (connection === 'close') {
            _isConnecting = false;
            isConnected   = false;
            await cleanupSocket();

            const error = lastDisconnect?.error;
            const statusCode = error?.output?.statusCode || error?.data || (error instanceof Boom ? error.output.statusCode : 0);
            const msg = error?.message || '';

            if (statusCode === 515 || statusCode === DisconnectReason.restartRequired) {
                console.log('[CONN] Soft restart required (515). Reconnecting in 3s for filesystem flush...');
                setTimeout(startSuite, 3000);
                return;
            }

            console.log(`[CONN] Connection closed. Status: ${statusCode}, Message: ${msg}`);

            // Handle true account logout (401 from WhatsApp server)
            if (statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
                console.log('[CONN] 🔴 Session logged out (401). Clearing session for fresh QR...');
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
    const pendingByChat = new Map();
    const limiterWaiters = [];

    let activeMessageTasks = 0;
    const configuredConcurrency = Number.parseInt(process.env.MESSAGE_CONCURRENCY, 10);
    const MAX_ACTIVE_MESSAGE_TASKS = Number.isFinite(configuredConcurrency)
        ? Math.max(1, Math.min(configuredConcurrency, 32))
        : 16;

    async function enqueueMessageTask(chatJid, task) {
        const enqueuedAt = Date.now();
        const previous = pendingByChat.get(chatJid) || Promise.resolve();
        const current = previous.catch(() => {}).then(async () => {
            while (activeMessageTasks >= MAX_ACTIVE_MESSAGE_TASKS) {
                await new Promise(resolve => limiterWaiters.push(resolve));
            }
            const queueWaitMs = Date.now() - enqueuedAt;
            if (queueWaitMs >= 10000) {
                console.warn(`[MESSAGE QUEUE] Waited ${(queueWaitMs / 1000).toFixed(1)}s for ${chatJid}; active=${activeMessageTasks}, queuedChats=${pendingByChat.size}`);
            }
            activeMessageTasks++;
            try {
                return await task();
            } finally {
                activeMessageTasks--;
                limiterWaiters.shift()?.();
            }
        });
        pendingByChat.set(chatJid, current);
        current.then(
            () => { if (pendingByChat.get(chatJid) === current) pendingByChat.delete(chatJid); },
            () => { if (pendingByChat.get(chatJid) === current) pendingByChat.delete(chatJid); }
        );
        return current;
    }

    sock.ev.removeAllListeners('messages.upsert');
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const tasks = messages
            .filter(msg => msg.message)
            .map((msg) => enqueueMessageTask(msg.key.remoteJid, async () => {
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

                    const appSettings = await getSettings();
                    const activePrefix = appSettings?.prefix || process.env.PREFIX || './';

                    // ── Default home_jid to the account's own chat ("Message yourself") ──
                    // Never anchor to whatever chat the first command was typed in: that
                    // could be a contact, and `home` output (DPs, view-once media) would
                    // then be delivered to them. Use `./home set` to pick another chat.
                    if (!appSettings.home_jid && sock.user?.id) {
                        try {
                            await updateSettings((s) => {
                                if (!s.home_jid) s.home_jid = jidNormalizedUser(sock.user.id);
                            });
                        } catch (_) {}
                    }

                    logMessage(sock, msg).catch(() => {});

                    // ── Auto-delete (admin power: auto-delete targets & stickers) ──
                    if (from.endsWith('@g.us') && !isSenderMe(sock, msg) && !msg.message.protocolMessage) {
                        const adSettings = appSettings;
                        if (adSettings.suite_enabled !== false) {
                            if (adSettings.autodelete?.targets?.length) {
                                await autoDeleteIfTarget(sock, msg, adSettings).catch(() => {});
                            }
                            if (adSettings.autodelete?.sticker_groups?.length) {
                                await autoDeleteIfSticker(sock, msg, adSettings).catch(() => {});
                            }
                        }
                    }

                    if (!msg.message.protocolMessage) {
                        try {
                            safeCacheMessage(msg.key.id, msg);

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
                                const cloned = JSON.parse(JSON.stringify(msg));
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
                        if (!originalMsg || isSenderMe(sock, originalMsg)) return;

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
                        if (isSenderMe(sock, msg) && from !== 'status@broadcast') {
                            const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                            if (body.startsWith(activePrefix)) {
                                await sock.sendPresenceUpdate('composing', from);
                                setTimeout(() => sock.sendPresenceUpdate('paused', from).catch(() => {}), 1500);
                            }
                        }
                    } catch (_) {}

                    let msgContent = msg.message;
                    if (msgContent?.ephemeralMessage?.message) msgContent = msgContent.ephemeralMessage.message;
                    if (msgContent?.viewOnceMessageV2?.message) msgContent = msgContent.viewOnceMessageV2.message;
                    if (msgContent?.viewOnceMessage?.message) msgContent = msgContent.viewOnceMessage.message;
                    if (msgContent?.documentWithCaptionMessage?.message) msgContent = msgContent.documentWithCaptionMessage.message;

                    const body = msgContent?.conversation || msgContent?.extendedTextMessage?.text || msgContent?.imageMessage?.caption || msgContent?.videoMessage?.caption || '';
                    const isProtocolMessage = !!msg.message.protocolMessage;
                    const isPendingPickerReply = global.ytPendingPickers?.has(from) && /^\s*[1-5]\s*$/.test(body);

                    const contextInfo = msgContent?.extendedTextMessage?.contextInfo || msg.message?.extendedTextMessage?.contextInfo;
                    const quotedStanzaId = contextInfo?.stanzaId;
                    const quotedText = contextInfo?.quotedMessage?.conversation || contextInfo?.quotedMessage?.extendedTextMessage?.text || '';
                    const isReplyingToAI = isAiMessage(quotedStanzaId, quotedText);
                    const isCallingRuby = /\bruby\b/i.test(body);
                    const isRubyAuto = !!appSettings?.ruby_auto_respond && !from.endsWith('@g.us') && !msg.key.fromMe;

                    if (!isProtocolMessage && !body.startsWith(activePrefix) && !isPendingPickerReply && !isCallingRuby && !isReplyingToAI && !isRubyAuto) return;

                    try {
                        await handleMessages(sock, msg);
                    } catch (handlerErr) {
                        if (isBadMacError(handlerErr)) await handleBadMacError(handlerErr);
                        else console.error(`[MESSAGE HANDLER] Failed for ${from} message ${msg.key.id}:`, handlerErr?.stack || handlerErr?.message || handlerErr);
                    }
                } catch (msgErr) {
                    if (isBadMacError(msgErr)) await handleBadMacError(msgErr);
                    else console.error(`[MESSAGE PIPELINE] Failed for ${msg.key.remoteJid} message ${msg.key.id}:`, msgErr?.stack || msgErr?.message || msgErr);
                }
            }));

        await Promise.allSettled(tasks);
    });


}

let _hasSyncedSession = false;

async function restoreSessionFromEnv() {
    const envData = process.env.SESSION_DATA || process.env.SESSION_BASE64;
    if (!envData) return;
    try {
        await fs.ensureDir(AUTH_FOLDER);
        const files = await fs.readdir(AUTH_FOLDER);
        if (files.length > 0) {
            _hasSyncedSession = true;
            return;
        }
        let decoded = envData.trim();
        if (!decoded.startsWith('{')) {
            decoded = Buffer.from(decoded, 'base64').toString('utf8');
        }
        const parsed = JSON.parse(decoded);
        if (parsed && typeof parsed === 'object') {
            if (parsed['creds.json']) {
                for (const [filename, content] of Object.entries(parsed)) {
                    const fileContent = typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content);
                    await fs.writeFile(path.join(AUTH_FOLDER, filename), fileContent, 'utf8');
                }
                console.log('[SESSION] Restored multi-file session state from environment variable.');
            } else if (parsed.me || parsed.noiseKey) {
                await fs.writeJson(path.join(AUTH_FOLDER, 'creds.json'), parsed, { spaces: 2 });
                console.log('[SESSION] Restored creds.json state from environment variable.');
            }
            _hasSyncedSession = true;
        }
    } catch (err) {
        console.error('[SESSION] Failed to restore session from env:', err.message);
    }
}

const SESSION_KEY_TTL_MS = 2 * 60 * 1000;
function scheduleSelfDelete(activeSock, jid, key) {
    if (!key) return;
    setTimeout(() => {
        activeSock.sendMessage(jid, { delete: key }).catch(() => {});
    }, SESSION_KEY_TTL_MS).unref?.();
}

async function exportSessionBundle() {
    try {
        const credsPath = path.join(AUTH_FOLDER, 'creds.json');
        if (!fs.existsSync(credsPath)) return null;

        const files = await fs.readdir(AUTH_FOLDER);
        const bundle = {};
        // Keep the bundle small enough for an env variable: the login itself
        // (creds.json) plus app-state keys. Signal sessions and pre-keys are
        // renegotiated automatically and would make the bundle grow with every
        // contact. For full persistence use a volume at /app/session_auth.
        const keep = (f) => f === 'creds.json' || /^app-state-sync-key-.*\.json$/.test(f);
        for (const file of files) {
            if (keep(file)) {
                const filePath = path.join(AUTH_FOLDER, file);
                try {
                    bundle[file] = await fs.readJson(filePath);
                } catch (_) {
                    try {
                        bundle[file] = await fs.readFile(filePath, 'utf8');
                    } catch (_) {}
                }
            }
        }
        if (!bundle['creds.json']) return null;
        return Buffer.from(JSON.stringify(bundle)).toString('base64');
    } catch (err) {
        console.error('[SESSION] Error bundling session files:', err.message);
        return null;
    }
}

// Railway GraphQL call that works with both token types:
//   • account / team tokens  → Authorization: Bearer <token>
//   • project tokens         → Project-Access-Token: <token>
async function railwayGraphql(token, query, variables, timeout = 15000) {
    const attempt = (headers) => axios.post('https://backboard.railway.com/graphql/v2', { query, variables }, {
        headers: { 'Content-Type': 'application/json', ...headers },
        timeout,
        validateStatus: () => true
    });
    const notAuthorized = (res) => res.status === 401 || res.status === 403 ||
        (res.data?.errors || []).some(e => /not authori[sz]ed|unauthori[sz]ed/i.test(e?.message || ''));

    let res = await attempt({ Authorization: `Bearer ${token}` });
    if (notAuthorized(res)) res = await attempt({ 'Project-Access-Token': token });
    if (res.status >= 400 || res.data?.errors?.length) {
        const detail = res.data?.errors?.map(e => e.message).join('; ') || `HTTP ${res.status}`;
        throw new Error(detail);
    }
    return res.data?.data;
}

async function deleteRailwaySessionVariable() {
    const token = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN;
    const projectId = process.env.RAILWAY_PROJECT_ID;
    const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
    const serviceId = process.env.RAILWAY_SERVICE_ID;

    if (!token || !projectId || !environmentId) return;
    try {
        const query = `
            mutation variableDelete($input: VariableDeleteInput!) {
                variableDelete(input: $input)
            }
        `;
        const variables = {
            input: {
                projectId,
                environmentId,
                serviceId: serviceId || undefined,
                name: 'SESSION_DATA'
            }
        };
        await railwayGraphql(token, query, variables, 10000);
        console.log('[RAILWAY] Removed stale SESSION_DATA variable from Railway.');
    } catch (_) {}
}

async function syncSessionAfterScan(targetSock, isManual = false) {
    if (_hasSyncedSession && !isManual) return;
    const activeSock = targetSock || sock;
    const base64Data = await exportSessionBundle();
    if (!base64Data) return null;
    _hasSyncedSession = true;

    // Cache in local process so subsequent calls within this run know it exists
    process.env.SESSION_DATA = base64Data;

    const token = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN;
    const projectId = process.env.RAILWAY_PROJECT_ID;
    const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
    const serviceId = process.env.RAILWAY_SERVICE_ID;

    let syncedToRailway = false;

    if (token && projectId && environmentId) {
        console.log('[RAILWAY] Syncing SESSION_DATA to Railway variables via API...');
        try {
            const query = `
                mutation variableUpsert($input: VariableUpsertInput!) {
                    variableUpsert(input: $input)
                }
            `;
            const variables = {
                input: {
                    projectId,
                    environmentId,
                    serviceId: serviceId || undefined,
                    name: 'SESSION_DATA',
                    value: base64Data,
                    // Saving the variable must not redeploy: a redeploy would start a
                    // second instance on the same session while this one is live.
                    skipDeploys: true
                }
            };
            const data = await railwayGraphql(token, query, variables);
            if (data?.variableUpsert) {
                syncedToRailway = true;
                console.log('[RAILWAY] ✅ Successfully wrote SESSION_DATA to Railway variables!');
            } else {
                console.error('[RAILWAY] variableUpsert returned:', JSON.stringify(data));
            }
        } catch (apiErr) {
            console.error('[RAILWAY] ❌ Could not save SESSION_DATA:', apiErr.message);
        }
    } else if (process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_PROJECT_ID || token) {
        const missing = [
            !token && 'RAILWAY_API_TOKEN',
            !projectId && 'RAILWAY_PROJECT_ID',
            !environmentId && 'RAILWAY_ENVIRONMENT_ID'
        ].filter(Boolean).join(', ');
        console.log(`[RAILWAY] SESSION_DATA not saved — missing: ${missing}.`);
    }

    const vaultJid = (await getVault()) || global.vault;

    if (syncedToRailway) {
        if (activeSock && vaultJid) {
            await activeSock.sendMessage(vaultJid, {
                text: '🛡️ *Railway Auto-Save Active*\n\n✅ Your session was automatically saved to Railway variables (`SESSION_DATA`).\n\nYou will *not* need to scan the QR code on future deployments!'
            }).catch(() => {});
        }
    } else {
        console.log('[SESSION] First scan completed. Session bundle generated.');
        console.log('[RAILWAY TIP] Set RAILWAY_API_TOKEN in Railway variables for automatic saving, or add a Volume at /app/session_auth.');

        if (activeSock && vaultJid) {
            try {
                if (!isManual) {
                    // Never push the session key into chat unprompted — it is a full
                    // account-takeover credential and chat history is backed up.
                    await activeSock.sendMessage(vaultJid, {
                        text: '🛡️ *First Scan Completed!*\n\nTo skip scanning the QR code on future Railway deployments, either:\n\n1️⃣ *Automatic (Recommended)*: Add `RAILWAY_API_TOKEN` to your Railway variables so the bot auto-saves its session directly.\n2️⃣ *Railway Volume*: Attach a Persistent Volume mounted at `/app/session_auth`.\n3️⃣ *Manual*: Send `./session` to get a one-time key for `SESSION_DATA` (it self-deletes after 2 minutes).'
                    });
                } else {
                    // Key always goes to the account's own chat, never a configurable vault/home.
                    const selfJid = activeSock.user?.id ? jidNormalizedUser(activeSock.user.id) : null;
                    if (!selfJid) return { syncedToRailway, base64Data };
                    await activeSock.sendMessage(selfJid, {
                        text: '🔐 *Session key below* — copy it into `SESSION_DATA` now. Anyone with this text can take over your WhatsApp. Both messages delete themselves in 2 minutes.'
                    }).then((warn) => scheduleSelfDelete(activeSock, selfJid, warn?.key));
                    const keyMsg = await activeSock.sendMessage(selfJid, { text: base64Data });
                    scheduleSelfDelete(activeSock, selfJid, keyMsg?.key);
                }
            } catch (_) {}
        }
    }

    return { syncedToRailway, base64Data };
}

global.exportSessionBundle = exportSessionBundle;
global.syncSessionAfterScan = syncSessionAfterScan;

async function startSuite() {
    if (_isConnecting) return;
    _isConnecting = true;

    try {
        await restoreSessionFromEnv();
        if (!process.env.NVIDIA_API_KEY) {
            console.log('[AI CONFIG] ℹ️ NVIDIA_API_KEY is not set. Set it in Railway variables to enable ./ai and ./ai image.');
        } else {
            console.log(`[AI CONFIG] ✓ NVIDIA AI configured (Model: ${process.env.NVIDIA_AI_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b'})`);
        }
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
            // Must stay false: while any linked device reports the account as
            // "online", WhatsApp stops sending push notifications to the phone.
            // With false, Baileys reports this device as 'unavailable' on connect.
            // Owners who want it can opt in with ./online on.
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            msgRetryCounterCache,
            msgRetryCounter: 5,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 5,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            emitOwnEvents: true,
            // WhatsApp rejects pairing-code logins from unrecognised browser
            // strings, so use a standard one when pairing by phone number.
            browser: PAIRING_NUMBER ? Browsers.ubuntu('Chrome') : [process.env.BOT_NAME || 'Suites', 'Chrome', '10.0.0'],
            transactionOpts: { maxCommitRetries: 5, delayBetweenTriesMs: 2000 },
            getMessage: async (key) => {
                if (!key || !key.id) return undefined;
                const cached = global.msgCache?.get(key.id);
                // Only ever return a real proto Message. Returning the whole
                // WebMessageInfo (or nothing usable) makes the retry arrive blank.
                return cached?.message || undefined;
            }
        });

        // ── Auto-cache all sent messages into msgCache to prevent "Waiting for message" on sender device ──
        const _origSendMessage = sock.sendMessage.bind(sock);
        sock.sendMessage = async (jid, content, options) => {
            const normJid = jid ? jidNormalizedUser(jid) : jid;
            // Never send (or edit to) an empty text bubble. Log where it came
            // from so the caller can be fixed, and skip the send.
            if (content && typeof content === 'object' && 'text' in content &&
                !content.image && !content.video && !content.document && !content.sticker && !content.audio &&
                (typeof content.text !== 'string' || !content.text.trim())) {
                console.warn(`[SEND] Blocked empty ${content.edit ? 'edit' : 'message'} to ${normJid}`, new Error().stack.split('\n').slice(2, 5).join(' | '));
                return undefined;
            }
            const sent = await _origSendMessage(normJid, content, options);
            // Cache what we actually sent so retry requests (phone couldn't decrypt)
            // can be answered. Edits are their own messages with their own ids; the
            // original's cache entry must stay untouched, or a retry for it would
            // resend a malformed message that shows up blank.
            if (sent && sent.key && sent.key.id) {
                safeCacheMessage(sent.key.id, sent);
            }
            return sent;
        };

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

        // Learn LID ↔ phone-number mappings (used by group auto-delete)
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
    console.error('[UNCAUGHT EXCEPTION]', err?.stack || err?.message || err);
    if (err?.message?.includes('Connection Failure') || err?.message?.includes('noise')) {
        _isConnecting = false;
        setTimeout(startSuite, 5000);
    }
});

process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(reason);
    console.error('[UNHANDLED REJECTION]', err?.stack || err?.message || err);
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

// ── Global memory pressure relief (every 5 minutes) ──
setInterval(() => {
    let cleaned = 0;
    // Prune msgCache to 1500 if oversized
    while (global.msgCache.size > 1500) {
        const firstKey = global.msgCache.keys().next().value;
        global.msgCache.delete(firstKey);
        cleaned++;
    }
    // Prune LID maps
    if (global.lidToPn.size > 5000) {
        const iter = global.lidToPn.keys();
        for (let i = 0; i < 1000; i++) { const k = iter.next().value; global.lidToPn.delete(k); global.pnToLid.delete(k); }
        cleaned += 1000;
    }
    // Prune retry map
    if (msgRetryMap.size > 500) {
        const iter = msgRetryMap.keys();
        for (let i = 0; i < 200; i++) msgRetryMap.delete(iter.next().value);
        cleaned += 200;
    }
    if (cleaned > 0) console.log(`[MEM] Pruned ${cleaned} stale cache entries.`);
    // Force GC if available
    if (global.gc) { try { global.gc(); } catch (_) {} }
}, 5 * 60 * 1000);

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

