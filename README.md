# 🛡️ Suites — WhatsApp Userbot (Crimson Engine)

**Suites** is a modular, high-performance WhatsApp userbot built with Node.js and `@whiskeysockets/baileys`. Designed for privacy monitoring, media recovery, intelligence gathering, and daily automated utilities.

---

## ✨ Features

- 🛡️ **Anti-Delete**: Intercepts and recovers deleted messages (text, audio, stickers, media, and View-Once content).
- ✏️ **Anti-Edit**: Logs original text whenever a contact edits a message.
- 👁️ **Anti-View-Once (`./<>`)**: Intercepts and converts View-Once photos/videos/audio into permanent media.
- 🗑️ **Auto-Delete (`./delete`)**: Admin power — any message a target sends in groups is deleted instantly (requires admin rights).
- 📡 **Track (`./track`)**: Fires a ghost call (audio offer) to a target — their phone rings once while the P2P handshake reveals their public IP, then the call is rejected after 2s. Enriched geo report (region, timezone, ISP, ASN, map link), cached per-target intel, 60s cooldown.
- 🖼️ **DP Fetcher (`./dp`)**: Downloads high-resolution profile pictures with built-in custom DNS resolution for WhatsApp media servers (`pps.whatsapp.net`).
- 🔍 **URL Investigator (`./investigate`)**: Captures a screenshot and metadata summary (title, description, site, resolved IPs) of any target URL — via argument or reply-quote, with `image`/`summary` modes.
- 🎨 **WebP Sticker Converter (`./s`)**: Converts photos, videos, and media replies into square 512x512 WebP stickers using FFmpeg.
- 🔌 **Master Switch (`./suite`)**: Pause or resume the engine instantly — persists across restarts. `./track` remains available while the suite is paused.

---

## 🚀 Quick Start

### Prerequisites
- **Node.js**: v16+ (Recommended: Node.js 18 or 20)
- **FFmpeg**: System FFmpeg or `ffmpeg-static` (installed automatically via `npm install`)
- Network access to `web.whatsapp.com`

### 1. Installation

```bash
# Clone repository
git clone https://github.com/crimsonej/suite.git
cd suite

# Install dependencies
npm install

# Run installer setup
npm run install
```

### 2. Launching the Bot

```bash
npm start
```

*Scan the generated QR code in your terminal using WhatsApp (Linked Devices).*

---

## 📜 Command Reference

All commands use the `./` prefix by default.

| Command | Arguments | Description | Example |
| :--- | :--- | :--- | :--- |
| `./antidelete` | `[on/off]` / `groups [on/off]` | Toggle deleted message recovery for private chats or groups | `./antidelete on` |
| `./antiedit` | `[on/off]` / `groups [on/off]` | Toggle edited message diff capturing | `./antiedit on` |
| `./<>` | *(Reply to View-Once media)* | Convert View-Once media into permanent media | `./<>` |
| `./delete` | `[number\|jid] on/off`, *(Reply)* | Auto-delete every message a target sends (groups, admin required) | `./delete 1234567890 on` |
| `./track` | `[number\|jid]` | Ghost-call probe: captures target's public IP via P2P handshake + geo report | `./track +256755930447` |
| `./dp` | `[@user]`, `[number]`, or *(Reply)* | Download high-res profile picture | `./dp 1234567890` |
| `./investigate` | `[url]` + `[image\|summary]`, or *(Reply)* | Screenshot + metadata summary of any URL | `./investigate https://example.com image` |
| `./s` | *(Reply to image/video)* | Convert media into square WebP sticker | `./s` |
| `./yt` | `audio\|video <url\|title>` | Download audio as voice note, or video up to 720p. Title mode shows a 5-option picker. | `./yt audio never gonna give you up` |
| `./status` | None | View OS RAM, uptime, and engine health | `./status` |
| `./suite` | `[on/off]` | Pause/resume the engine (the `./track` command remains available while paused) | `./suite off` |
| `./help` or `./menu` | None | Display interactive command menu | `./help` |

---

## ⚙️ Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DNS_SERVERS` | `8.8.8.8,8.8.4.4,1.1.1.1,1.0.0.1` | Comma-separated public DNS servers to resolve WhatsApp servers and bypass local DNS blocks |
| `IPINFO_TOKEN` | *(None)* | Optional API token for [ipinfo.io](https://ipinfo.io) geolocation lookup fallback |

Example usage:
```bash
DNS_SERVERS="8.8.8.8,1.1.1.1" npm start
```

---

## 🛠️ Network & Connection Troubleshooting

If you encounter `EAI_AGAIN` or socket connection timeouts on Linux/Termux, force public DNS resolution:
   ```bash
   DNS_SERVERS="8.8.8.8,1.1.1.1" npm start
   ```

---

## 📄 License & Credits

Created by **Crimson** — [github.com/crimsonej](https://github.com/crimsonej)  
Powered by `@whiskeysockets/baileys`.
