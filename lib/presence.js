// Always-online control (./online on|off).
//
// Off by default: while any linked device reports the account as "available",
// WhatsApp stops sending push notifications to the phone. When the owner turns
// it on, we report "available" and refresh it periodically so the account keeps
// showing as online for as long as the bot is connected.

const REFRESH_MS = Number(process.env.ONLINE_REFRESH_MS) || 4 * 60 * 1000;

let _timer = null;

function stopRefresh() {
    if (_timer) clearInterval(_timer);
    _timer = null;
}

async function applyPresence(sock, alwaysOnline) {
    stopRefresh();
    if (!sock) return;
    const type = alwaysOnline ? 'available' : 'unavailable';
    await sock.sendPresenceUpdate(type).catch((err) => {
        console.error(`[PRESENCE] Could not set ${type}:`, err.message);
    });
    if (alwaysOnline) {
        _timer = setInterval(() => {
            sock.sendPresenceUpdate('available').catch(() => {});
        }, REFRESH_MS);
        _timer.unref?.();
    }
}

module.exports = { applyPresence, stopRefresh };
