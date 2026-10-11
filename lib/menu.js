function getMenu(p = './') {
    return "```" + `
╔══════════════════════════╗
║𝕮 𝕽 𝕴 𝕸 𝕾 𝕺 𝕹  𝕾 𝖀 𝕴 𝕿 𝕰║
╠══════════════════════════╣
║ 🛡️ PRIVACY & PROTECTION  ║
╟──────────────────────────╢
║ ❯ ${p}antidelete [on/off]  ║
║   (Private chat toggle)  ║
║ ❯ ${p}antidelete groups    ║
║   [on/off] (Global)      ║
║ ❯ ${p}antiedit [on/off]    ║
║   (Edit notification)    ║
║ ❯ ${p}antiedit groups      ║
║   [on/off] (Global)      ║
║ ❯ ${p}<> [home]             ║
║   (Save View-Once reply) ║
║ ❯ ${p}delete [@user|sticker]║
║   on/off (Auto-delete)   ║
╠══════════════════════════╣
║ 🔍 INTEL & RECON         ║
╟──────────────────────────╢
║ ❯ ${p}track [@user|number] ║
║   (Ghost-call IP probe) ║
║   (P2P IP Probe)         ║
║ ❯ ${p}dp [@target] [home]  ║
║   (Get Profile Picture)  ║
║ ❯ ${p}investigate [url]    ║
║   (Screenshot + summary) ║
║ ❯ ${p}status               ║
║   (System Engine Health)  ║
╠══════════════════════════╣
║ 🎵 MEDIA DOWNLOADER      ║
╟──────────────────────────╢
║ ❯ ${p}yt audio <url|title> ║
║   (Direct voice note)    ║
║ ❯ ${p}yt video <url|title> ║
║   (720p / doc fallback)  ║
╠══════════════════════════╣
║ 🤖 ARTIFICIAL INTEL      ║
╟──────────────────────────╢
║ ❯ ${p}ruby [on/off]        ║
║   (Auto-respond & summary) ║
║ ❯ ${p}ai / ${p}ruby <prompt>   ║
║   (Ruby Nemotron Q&A)    ║
║ ❯ ${p}search <query>       ║
║   (Live web search Q&A)    ║
║ ❯ ${p}AI <prompt>          ║
║   (Stealth Q&A, no header)║
║ ❯ ${p}ai clear / reset     ║
║   (Reset Ruby chat memory)║
║ ❯ ${p}ai image <prompt>    ║
║   (Flux image generator) ║
║ ❯ ${p}s ${p}ai image <txt>   ║
║   (Generate as sticker)  ║
╠══════════════════════════╣
║ ⚙️ UTILITIES             ║
╟──────────────────────────╢
║ ❯ ${p}s                   ║
║   (Media to WebP Sticker)║
║ ❯ ${p}home [on/off]        ║
║   (Set Home output chat) ║
║ ❯ ${p}session              ║
║   (Sync/backup session)  ║
║ ❯ ${p}suite [on/off]       ║
║   (Master engine switch) ║
║ ❯ ${p}help / ${p}menu        ║
║   (Show this menu)       ║
╚══════════════════════════╝
   Created by Crimson
   github.com/crimsonej
` + "```";
}

module.exports = { getMenu };
