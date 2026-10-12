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
| `./s ./ai image` | `<prompt>` | **Stacked Pipe**: Generate AI image and directly output as a sticker | `./s ./ai image a green frog` |
| `./ai` | `[prompt]` | Fast concise Q&A via NVIDIA Nemotron; running without prompt shows AI status & model health | `./ai` or `./ai who was nikola tesla` |
| `./AI` | `<prompt>` | **Stealth Q&A**: Edits message to `...` then directly outputs answer (no header) | `./AI who was nikola tesla` |
| `./ai image` | `<prompt>` | High-resolution image generation via NVIDIA Flux | `./ai image cyber frog in pond` |
| `./yt` | `audio\|video <url\|title>` | Download audio as voice note, or video up to 720p. Title mode shows a 5-option picker. | `./yt audio never gonna give you up` |
| `./status` | None | View OS RAM, uptime, and engine health | `./status` |
| `./session` | None | Export/sync session keys to avoid scanning QR again | `./session` |
| `./suite` | `[on/off]` | Pause/resume the engine (the `./track` command remains available while paused) | `./suite off` |
| `./help` or `./menu` | None | Display interactive command menu | `./help` |

---

## ⚙️ Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `NVIDIA_API_KEY` | *(None)* | **Required for AI**: API Key from NVIDIA NIM / Build portal |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | Base URL for OpenAI-compatible NVIDIA chat completions |
| `NVIDIA_AI_MODEL` | `nvidia/nemotron-3-ultra-550b-a55b` | Model identifier for text queries |
| `NVIDIA_IMAGE_INVOKE_URL` | `https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b` | Invoke URL for Flux image generation |
| `DATA_DIR` | `./media` | Directory for persistent settings, Ruby activity history, and vault state. Set to `/data` when using a Railway Volume. |
| `SESSION_DATA` | *(None)* | Base64-encoded WhatsApp session keys (avoids QR scan on fresh deploys) |
| `RAILWAY_API_TOKEN` | *(None)* | Railway Personal Access Token. When set, the bot **automatically saves** its session into Railway variables on first QR scan! |
| `DNS_SERVERS` | `8.8.8.8,8.8.4.4,1.1.1.1,1.0.0.1` | Comma-separated public DNS servers to resolve WhatsApp servers and bypass local DNS blocks |
| `IPINFO_TOKEN` | *(None)* | Optional API token for [ipinfo.io](https://ipinfo.io) geolocation lookup fallback |
| `YT_COOKIES_PATH` | `./cookies.txt` | Path to cookies file for YouTube downloads |
| `YT_COOKIES` | *(None)* | YouTube cookies in any format (JSON, header string, Base64, or Netscape) |
| `YT_PO_TOKEN` | *(None)* | Proof of Origin token for YouTube downloads on restricted VPS IPs |

Example usage:
```bash
DNS_SERVERS="8.8.8.8,1.1.1.1" npm start
```

### Persisting settings and activity history on Railway

Railway's container filesystem is temporary unless a Persistent Volume is attached. To keep settings such as feature toggles, auto-delete targets, the Ruby activity log, and the vault JID across redeploys:

1. Attach a Railway Volume to the service at `/data`.
2. Set the service variable `DATA_DIR=/data`.
3. Redeploy once. If `/data` is empty, Suites copies the existing `media/settings.json` and `media/vault.json` there on first startup; later changes are saved directly to the volume.

Keep the existing `/app/session_auth` volume or `SESSION_DATA` setup for WhatsApp authentication. `DATA_DIR` persists application settings and does not replace session persistence.

---

## 🍪 YouTube Downloading on VPS (Bypassing Cookie / Bot Restrictions)

YouTube blocks many datacenter IP ranges (Railway, AWS, DigitalOcean, Hetzner, etc.) with bot challenges or sign-in requirements. Suites automatically falls back to lightweight embedded player clients (`tv_embedded`, `ios`, `android`), but for restricted VPS servers, you can provide cookies in **any format**:

- **JSON Format**: Exported directly from browser extensions (e.g. *Cookie-Editor*, *EditThisCookie* on mobile or desktop).
- **HTTP Header String**: Copied from browser DevTools / cURL / mobile network requests (`LOGIN_INFO=...; SID=...`).
- **Base64 String**: Any encoded cookie string (avoids multiline/tab issues when pasting into Railway or `.env`).
- **Netscape Format**: Standard `cookies.txt` or space-separated lines.

You can supply them either by:
1. Setting the environment variable `YT_COOKIES` in Railway or `.env`.
2. Placing a `cookies.txt` file in the root directory (or pointing `YT_COOKIES_PATH` to it).

The engine automatically detects the format and normalizes it for `yt-dlp`.


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
