const crypto = require('crypto');

function newCallId() {
    return crypto.randomBytes(16).toString('hex');
}

async function ghostCall(sock, targetJid) {
    const tag = sock.generateMessageTag();
    const cid = newCallId();
    const ts = Date.now();
    const selfJid = sock.user?.id || targetJid;

    const dataNode = {
        tag: 'data',
        attrs: {
            id: sock.generateMessageTag(),
            'call-id': cid,
            to: targetJid,
            from: selfJid
        },
        content: [
            { tag: 'display_name', attrs: {}, content: Buffer.from('WhatsApp Voice Call') },
            { tag: 'encrypt', attrs: {}, content: Buffer.from(crypto.randomBytes(32).toString('base64')) },
            { tag: 'media', attrs: { type: 'audio' } },
            { tag: 'timestamp', attrs: { t: ts } }
        ]
    };

    const node = {
        tag: 'call',
        attrs: { id: tag },
        content: [
            {
                tag: 'offer',
                attrs: {
                    'call-id': cid,
                    from: selfJid,
                    to: targetJid,
                    'call-creator': selfJid
                },
                content: [dataNode]
            }
        ]
    };

    await sock.sendNode(node);
    return cid;
}

module.exports = { ghostCall, newCallId };