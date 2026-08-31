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
║ ❯ ./<> [home]             ║
║   (Save View-Once reply) ║
║ ❯ ./delete [@user|number]║
║   on/off (Auto-delete)   ║
╠══════════════════════════╣
║ 🔍 INTEL & RECON         ║
╟──────────────────────────╢
║ ❯ ./track [@user|number] ║
║   (Ghost-call IP probe) ║
║   (P2P IP Probe)         ║
║ ❯ ./dp [@target] [home]  ║
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
