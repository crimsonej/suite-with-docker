const chalk = require('chalk');

const nameCache = new Map();
const NAME_TTL_MS = 30 * 60 * 1000;

function ts() {
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function shortJid(jid) {
    return jid ? jid.split('@')[0] : '?';
}

function pnOf(jid) {
    if (!jid) return '?';
    if (jid.endsWith('@lid')) {
        const mapped = global.lidToPn?.get(jid);
        return mapped ? `+${shortJid(mapped)}` : `+${shortJid(jid)}`;
    }
    if (jid.endsWith('@s.whatsapp.net')) return `+${shortJid(jid)}`;
    return shortJid(jid);
}

async function resolveName(sock, jid, groupJid = null) {
    if (!jid) return '?';
    const cacheKey = groupJid ? `${groupJid}::${jid}` : jid;
    const cached = nameCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < NAME_TTL_MS) return cached.name;

    let name = shortJid(jid);
    try {
        if (jid.endsWith('@g.us')) {
            const meta = await sock.groupMetadata(jid);
            if (meta?.subject) name = meta.subject;
        } else {
            // For LID JIDs, try the corresponding phone JID if known
            let lookupJid = jid;
            if (jid.endsWith('@lid')) {
                const mappedPn = global.lidToPn?.get(jid);
                if (mappedPn) lookupJid = mappedPn;
            }
            const n = await sock.getName(lookupJid);
            if (n && n !== shortJid(lookupJid) && n !== shortJid(jid)) name = n;
        }
    } catch (_) {}

    // Fallback: if still just digits, try to find a push name in group participants
    if (name === shortJid(jid) && groupJid && groupJid.endsWith('@g.us')) {
        try {
            const meta = await sock.groupMetadata(groupJid);
            const participant = (meta?.participants || []).find(
                (p) => p.id === jid
                  || p.lid === jid
                  || p.id === jid.replace('@lid', '@s.whatsapp.net')
                  || p.jid === jid
            );
            if (participant?.name) name = participant.name;
            else if (participant?.notify) name = participant.notify;
            else if (participant?.verifiedName) name = participant.verifiedName;
        } catch (_) {}
    }

    nameCache.set(cacheKey, { name, ts: Date.now() });
    return name;
}

function describeContent(msg) {
    let content = msg.message || {};
    if (content.ephemeralMessage) content = content.ephemeralMessage.message || content;
    if (content.viewOnceMessageV2) content = content.viewOnceMessageV2.message || content;
    if (content.viewOnceMessageV2Extension) content = content.viewOnceMessageV2Extension.message || content;
    if (content.viewOnceMessage) content = content.viewOnceMessage.message || content;

    if (content.conversation) return { icon: '📝', label: 'text', preview: content.conversation };
    if (content.extendedTextMessage) return { icon: '📝', label: 'text', preview: content.extendedTextMessage.text || '' };
    if (content.imageMessage) return { icon: '🖼️', label: 'image', preview: content.imageMessage.caption || '', vo: !!content.imageMessage.viewOnce };
    if (content.videoMessage) return { icon: '🎬', label: 'video', preview: content.videoMessage.caption || '', vo: !!content.videoMessage.viewOnce };
    if (content.audioMessage) return { icon: '🎵', label: content.audioMessage.ptt ? 'voice note' : 'audio', preview: '', vo: !!content.audioMessage.viewOnce };
    if (content.stickerMessage) return { icon: '🖼️', label: 'sticker', preview: '' };
    if (content.documentMessage) return { icon: '📄', label: 'document', preview: content.documentMessage.fileName || '' };
    if (content.contactMessage) return { icon: '👤', label: 'contact', preview: content.contactMessage.displayName || '' };
    if (content.locationMessage) return { icon: '📍', label: 'location', preview: content.locationMessage.name || content.locationMessage.address || '' };
    if (content.liveLocationMessage) return { icon: '📍', label: 'live location', preview: '' };
    if (content.pollCreationMessage) return { icon: '📊', label: 'poll', preview: content.pollCreationMessage.name || '' };
    if (content.reactionMessage) return { icon: '💬', label: 'reaction', preview: content.reactionMessage.text || '' };
    if (content.protocolMessage) return { icon: '🔄', label: 'protocol', preview: '' };
    return { icon: '❓', label: 'other', preview: '' };
}

function isSenderMe(sock, msg, settings = null) {
    if (!msg || !msg.key) return false;
    if (msg.key.fromMe) return true;

    const from = msg.key.remoteJid || '';
    const isGroup = from.endsWith('@g.us');
    const sender = isGroup ? (msg.key.participant || msg.participant) : from;
    if (!sender) return false;

    const cleanJid = (j) => (j || '').split('@')[0].split(':')[0];
    const senderClean = cleanJid(sender);
    if (!senderClean) return false;

    if (sock?.user) {
        if (sock.user.id && cleanJid(sock.user.id) === senderClean) return true;
        if (sock.user.lid && cleanJid(sock.user.lid) === senderClean) return true;
    }

    if (global.vault && cleanJid(global.vault) === senderClean) return true;

    if (settings?.home_jid && cleanJid(settings.home_jid) === senderClean) return true;

    if (sender.endsWith('@lid') && global.lidToPn) {
        const mappedPn = global.lidToPn.get(sender);
        if (mappedPn) {
            const mappedClean = cleanJid(mappedPn);
            if (sock?.user?.id && cleanJid(sock.user.id) === mappedClean) return true;
            if (global.vault && cleanJid(global.vault) === mappedClean) return true;
            if (settings?.home_jid && cleanJid(settings.home_jid) === mappedClean) return true;
        }
    }

    if (sender.endsWith('@s.whatsapp.net') && global.pnToLid) {
        const mappedLid = global.pnToLid.get(sender);
        if (mappedLid) {
            const mappedClean = cleanJid(mappedLid);
            if (sock?.user?.lid && cleanJid(sock.user.lid) === mappedClean) return true;
        }
    }

    return false;
}

async function logMessage(sock, msg) {
    try {
        const from = msg.key.remoteJid;
        if (!from) return;
        
        // Skip logging status messages
        if (from === 'status@broadcast') return;

        const isMe = isSenderMe(sock, msg);
        const chatName = from === 'status@broadcast' ? 'Status' : await resolveName(sock, from);
        const senderJid = msg.key.participant || from;
        const senderName = isMe ? 'Me' : (from.endsWith('@g.us') ? await resolveName(sock, senderJid) : chatName);

        const info = describeContent(msg);
        const voTag = info.vo ? ' (view-once)' : '';
        const preview = info.preview ? `: ${info.preview}` : '';
        const arrow = isMe ? chalk.green('▶') : chalk.cyan('◀');
        const dir = isMe ? 'OUT' : 'IN ';

        let line = `[${ts()}] ${arrow} ${chalk.bold(dir)} | ${chatName} <${senderName}> ${info.icon} ${info.label}${voTag}${preview}`;
        if (line.length > 320) line = line.slice(0, 320) + '…';
        console.log(line);
    } catch (_) {}
}

function logCommand(from, command, args) {
    const argStr = args.length ? ' ' + args.join(' ') : '';
    console.log(`[${ts()}] ${chalk.yellow('⌨ CMD')} | ${shortJid(from)} ./${command}${argStr}`);
}

async function logDeletion(sock, from, participant, suppressed) {
    try {
        const source = from?.endsWith('@g.us')
            ? `${await resolveName(sock, from)} <${shortJid(from)}>`
            : pnOf(from);
        console.log(`[${ts()}] ${suppressed ? chalk.gray('🚫 DEL suppressed') : chalk.red('🗑 DEL recovered')} | ${source} ← ${pnOf(participant)}`);
    } catch (_) {}
}

async function logEdit(sock, from, participant) {
    try {
        const source = from?.endsWith('@g.us')
            ? `${await resolveName(sock, from)} <${shortJid(from)}>`
            : pnOf(from);
        console.log(`[${ts()}] ${chalk.magenta('✏️ EDIT')} | ${source} ← ${pnOf(participant)}`);
    } catch (_) {}
}

async function pnForDisplay(sock, jid, groupJid = null) {
    if (!jid) return '?';
    if (jid.endsWith('@s.whatsapp.net')) return `+${shortJid(jid)}`;
    if (jid.endsWith('@lid')) {
        const mapped = global.lidToPn?.get(jid);
        if (mapped) return `+${shortJid(mapped)}`;
        if (groupJid && groupJid.endsWith('@g.us')) {
            try {
                const meta = await sock.groupMetadata(groupJid);
                const p = (meta?.participants || []).find(
                    (pp) => pp.id === jid || pp.lid === jid || pp.jid === jid
                );
                const phoneJid = p?.jid || p?.phoneNumber;
                if (phoneJid) return `+${shortJid(phoneJid)}`;
            } catch (_) {}
        }
        return `+${shortJid(jid)}`;
    }
    return shortJid(jid);
}

async function formatUserLabel(sock, jid, groupJid = null) {
    if (!jid) return '?';
    const name = await resolveName(sock, jid, groupJid);
    const phone = await pnForDisplay(sock, jid, groupJid);
    const cleanDigits = jid.split('@')[0];
    if (name && name !== cleanDigits && !/^\d+$/.test(name)) {
        return `${name} (${phone})`;
    }
    return phone;
}

function pruneNames() {
    const now = Date.now();
    for (const [jid, entry] of nameCache) {
        if (now - entry.ts > NAME_TTL_MS) nameCache.delete(jid);
    }
}
setInterval(pruneNames, 10 * 60 * 1000);

module.exports = { logMessage, logCommand, logDeletion, logEdit, resolveName, pnOf, pnForDisplay, formatUserLabel, isSenderMe };