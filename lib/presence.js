// Presence control (./online on|off).
//
// Off by default. WhatsApp stops sending push notifications to the phone while
// any linked device reports the account as "available" (online). Setting it
// offline once on connect is NOT enough: the bot stays connected and sends
// typing indicators, so WhatsApp drifts the linked device back to "online"
// after a while and notifications quietly stop again.
//
// So we run a heartbeat that keeps re-asserting the desired presence:
//   • always_online OFF (default) → re-assert "unavailable" often, so the phone
//     keeps getting notifications no matter what the connection does.
//   • always_online ON           → re-assert "available" so the account stays
//     showing online for as long as the bot is connected.

const ONLINE_REFRESH_MS = Number(process.env.ONLINE_REFRESH_MS) || 4 * 60 * 1000;
const OFFLINE_HEARTBEAT_MS = Number(process.env.OFFLINE_HEARTBEAT_MS) || 60 * 1000;

let _timer = null;

function stopRefresh() {
    if (_timer) clearInterval(_timer);
    _timer = null;
}

async function applyPresence(sock, alwaysOnline) {
    stopRefresh();
    if (!sock) return;
    const type = alwaysOnline ? 'available' : 'unavailable';

    const send = () => sock.sendPresenceUpdate(type).catch((err) => {
        console.error(`[PRESENCE] Could not set ${type}:`, err?.message || err);
    });

    await send();

    const every = alwaysOnline ? ONLINE_REFRESH_MS : OFFLINE_HEARTBEAT_MS;
    _timer = setInterval(() => { send(); }, every);
    _timer.unref?.();
}

module.exports = { applyPresence, stopRefresh };
