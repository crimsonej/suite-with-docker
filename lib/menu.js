const prefix = './';

function getMenu() {
    return "```" + `
╔══════════════════════════╗
║𝕮 𝕽 𝕴 𝕸 𝕾 𝕺 𝕹  𝕾 𝖀 𝕴 𝕿 𝕰║
╠══════════════════════════╣
║ 🛡️ PRIVACY & PROTECTION  ║
╟──────────────────────────╢
║ ❯ ./antidelete [on/off]  ║
║   (Private chat toggle)  ║
║ ❯ ./antidelete groups    ║
║   [on/off] (Global)      ║
║ ❯ ./antiedit [on/off]    ║
║   (Edit notification)    ║
║ ❯ ./antiedit groups      ║
║   [on/off] (Global)      ║
║ ❯ ./<>                   ║
║   (Save View-Once reply) ║
║ ❯ ./delete [jid|number]  ║
║   on/off (Auto-delete)   ║
╠══════════════════════════╣
║ 🔍 INTEL & RECON         ║
╟──────────────────────────╢
║ ❯ ./track [number|jid] ║
║   (Ghost-call IP probe) ║
║   (P2P IP Probe)         ║
║ ❯ ./dp [@user|number]    ║
║   (Get Profile Picture)  ║
║ ❯ ./investigate [url]    ║
║   (Screenshot + summary) ║
║ ❯ ./status               ║
║   (System Engine Health)  ║
╠══════════════════════════╣
║ 🎵 MEDIA DOWNLOADER      ║
╟──────────────────────────╢
║ ❯ ./yt audio <url|title> ║
║   (Direct voice note)    ║
║ ❯ ./yt video <url|title> ║
║   (720p / doc fallback)  ║
╠══════════════════════════╣
║ ⚙️ UTILITIES             ║
╟──────────────────────────╢
║ ❯ ./s                   ║
║   (Media to WebP Sticker)║
║ ❯ ./suite [on/off]       ║
║   (Master engine switch) ║
║ ❯ ./help / ./menu        ║
║   (Show this menu)       ║
╚══════════════════════════╝
   Created by Crimson
   github.com/crimsonej
` + "```";
}

module.exports = { getMenu };
