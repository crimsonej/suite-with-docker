const axios = require('axios');

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const DEFAULT_IMAGE_INVOKE_URL = 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b';

function getNvidiaApiKey() {
    return (process.env.NVIDIA_API_KEY || '').trim();
}

// Conversation memory per chat
// Map of chatJid -> Array<{ role: 'user' | 'assistant', content: string, timestamp: number }>
const chatHistories = new Map();
const MAX_HISTORY_MESSAGES = 16; // Up to 8 full conversational exchanges
const HISTORY_EXPIRY_MS = 45 * 60 * 1000; // 45 minutes of inactivity resets conversation

// AI message ID tracking for swipe-and-reply detection
const aiMessageIds = new Set();
const MAX_TRACKED_IDS = 300;

function recordAiMessageId(id) {
    if (!id) return;
    aiMessageIds.add(String(id));
    if (aiMessageIds.size > MAX_TRACKED_IDS) {
        const first = aiMessageIds.values().next().value;
        aiMessageIds.delete(first);
    }
}

function isAiMessage(stanzaId, text = '') {
    if (stanzaId && aiMessageIds.has(String(stanzaId))) return true;
    if (text) {
        if (/✦\s*(?:SUITE AI|RUBY)/i.test(text)) return true;
        if (/⚡\s*(?:SUITE AI|RUBY)/i.test(text)) return true;
    }
    return false;
}

function clearAIHistory(chatJid = 'default') {
    chatHistories.delete(chatJid);
}

function hasActiveConversation(chatJid = 'default') {
    const history = chatHistories.get(chatJid);
    if (!history || history.length === 0) return false;
    const lastMsgTime = history[history.length - 1].timestamp || 0;
    return (Date.now() - lastMsgTime) <= HISTORY_EXPIRY_MS;
}

function recordConversationExchange(chatJid, userMsg, aiMsg) {
    if (!chatJid) return;
    const now = Date.now();
    let history = chatHistories.get(chatJid) || [];
    history.push({ role: 'user', content: userMsg, timestamp: now });
    history.push({ role: 'assistant', content: aiMsg, timestamp: now });
    if (history.length > MAX_HISTORY_MESSAGES) {
        history = history.slice(-MAX_HISTORY_MESSAGES);
    }
    chatHistories.set(chatJid, history);
}

/**
 * Ask text questions / prompts to NVIDIA Nemotron model with continuous conversational memory.
 * Ruby is concise, sharp, direct, and aware of her identity.
 */
async function askAI(prompt, options = {}) {
    const apiKey = getNvidiaApiKey();
    if (!apiKey) {
        throw new Error('NVIDIA_API_KEY is not set. Please set it in your Railway variables or .env file.');
    }

    const baseUrl = (process.env.NVIDIA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = process.env.NVIDIA_AI_MODEL || DEFAULT_MODEL;
    const chatJid = options.chatJid || 'default';
    const now = Date.now();

    const systemPrompt = `You are Ruby, the ultra-sharp, intelligent AI core built natively into Crimson Suite.
Your name is Ruby.
You were created by Crimson (github.com/crimsonej).
You are female.
You must be very brief, sharp, and precise.
Only answer what is asked—nothing more, nothing less.
Avoid pleasantries, fluff, or excessive words unless requested.
Never say you are an unnamed model; you are Ruby, the AI of Crimson Suite.`;

    let history = chatHistories.get(chatJid) || [];
    // If the last interaction was over 45 mins ago, start a fresh session
    if (history.length > 0 && (now - (history[history.length - 1].timestamp || 0)) > HISTORY_EXPIRY_MS) {
        history = [];
    }

    const messages = [
        {
            role: 'system',
            content: systemPrompt
        }
    ];

    // Append prior conversational turns
    for (const h of history) {
        messages.push({
            role: h.role,
            content: h.content
        });
    }

    // If external context was quoted from another message and history is empty
    if (options.context && history.length === 0) {
        messages.push({
            role: 'user',
            content: `Context: ${options.context}`
        });
    }

    messages.push({
        role: 'user',
        content: prompt
    });

    const endpoint = `${baseUrl}/chat/completions`;
    const res = await axios.post(
        endpoint,
        {
            model,
            messages,
            temperature: 0.5,
            top_p: 0.9,
            max_tokens: 1024
        },
        {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 60000
        }
    );

    const reply = res.data?.choices?.[0]?.message?.content;
    if (!reply) {
        throw new Error('Empty response received from NVIDIA AI.');
    }

    const cleanReply = reply.trim();

    // Persist to conversation history
    history.push({ role: 'user', content: prompt, timestamp: now });
    history.push({ role: 'assistant', content: cleanReply, timestamp: now });

    if (history.length > MAX_HISTORY_MESSAGES) {
        history = history.slice(-MAX_HISTORY_MESSAGES);
    }
    chatHistories.set(chatJid, history);

    return cleanReply;
}

/**
 * Generate images using NVIDIA Flux endpoint.
 * Returns a Buffer of the generated image.
 */
async function generateImage(prompt) {
    const apiKey = getNvidiaApiKey();
    if (!apiKey) {
        throw new Error('NVIDIA_API_KEY is not set. Please set it in your Railway variables or .env file.');
    }

    const invokeUrl = (process.env.NVIDIA_IMAGE_INVOKE_URL || DEFAULT_IMAGE_INVOKE_URL).trim();

    const payload = {
        prompt: prompt.trim(),
        width: 1024,
        height: 1024,
        seed: 0,
        steps: 4
    };

    const res = await axios.post(
        invokeUrl,
        payload,
        {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            timeout: 120000
        }
    );

    // Parse image from various response formats
    let imageBuffer = null;

    if (res.data?.artifacts?.[0]?.base64) {
        const b64 = res.data.artifacts[0].base64.replace(/^data:image\/\w+;base64,/, '');
        imageBuffer = Buffer.from(b64, 'base64');
    } else if (res.data?.b64_json) {
        imageBuffer = Buffer.from(res.data.b64_json, 'base64');
    } else if (res.data?.data?.[0]?.b64_json) {
        imageBuffer = Buffer.from(res.data.data[0].b64_json, 'base64');
    } else if (res.data?.data?.[0]?.url) {
        const imgDownload = await axios.get(res.data.data[0].url, { responseType: 'arraybuffer' });
        imageBuffer = Buffer.from(imgDownload.data);
    } else if (typeof res.data === 'string' && res.data.startsWith('data:image')) {
        const b64 = res.data.split(',')[1];
        imageBuffer = Buffer.from(b64, 'base64');
    }

    if (!imageBuffer || imageBuffer.length === 0) {
        throw new Error('Could not extract image data from NVIDIA response. Received: ' + JSON.stringify(res.data).slice(0, 200));
    }

    return {
        buffer: imageBuffer,
        mimetype: 'image/jpeg'
    };
}

/**
 * Get AI status card showing model, key, and image generator status.
 */
async function getAIStatus() {
    const apiKey = getNvidiaApiKey();
    const hasKey = !!apiKey;

    // -- Model display --
    const explicitModel = process.env.NVIDIA_AI_MODEL;
    let modelDisplay;
    if (!hasKey) {
        modelDisplay = '⚠️ Not Configured';
    } else if (explicitModel) {
        modelDisplay = explicitModel;
    } else {
        modelDisplay = `${DEFAULT_MODEL} _(default)_`;
    }

    // -- Image model display --
    const explicitImageUrl = process.env.NVIDIA_IMAGE_INVOKE_URL;
    const invokeUrl = (explicitImageUrl || DEFAULT_IMAGE_INVOKE_URL).trim();
    const imageModelMatch = invokeUrl.match(/genai\/(.+)$/i);
    const imageModel = imageModelMatch ? imageModelMatch[1] : 'flux.2-klein-4b';
    let imageModelDisplay;
    if (!hasKey) {
        imageModelDisplay = '⚠️ Not Configured';
    } else if (explicitImageUrl) {
        imageModelDisplay = imageModel;
    } else {
        imageModelDisplay = `${imageModel} _(default)_`;
    }

    // -- Service statuses --
    let textStatus = hasKey ? '🟢 Active' : '🔴 Inactive (No API Key)';
    let imageStatus = hasKey ? `🟢 Active` : '🔴 Inactive (No API Key)';

    const baseUrl = (process.env.NVIDIA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

    if (hasKey) {
        try {
            const testRes = await axios.get(`${baseUrl}/models`, {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                timeout: 5000
            }).catch(() => null);

            if (testRes && testRes.status >= 200 && testRes.status < 300) {
                textStatus = '🟢 Connected & Operational';
            }
        } catch (_) {}
    }

    // -- Build status card --
    const setupHint = !hasKey
        ? `\n_⚙️ Set NVIDIA_API_KEY in Railway/.env to activate._`
        : '';

    return `╔════════════════════════════════╗
║      ✦ *SUITE AI STATUS* ✦      ║
╠════════════════════════════════╣
║ ❯ Persona    : Ruby
║ ❯ Model      : ${modelDisplay}
║ ❯ Text AI    : ${textStatus}
║ ❯ Image Gen  : ${imageStatus}
║ ❯ Image Model: ${imageModelDisplay}
╚════════════════════════════════╝${setupHint}`;
}

/**
 * Auto-responder generation for when Crimson is away and ./ruby on is active.
 * Evaluates whether the incoming message warrants a response and generates an in-character reply.
 */
async function generateAutoResponse(incomingText, senderName = 'Contact') {
    const apiKey = getNvidiaApiKey();
    if (!apiKey) return null;

    const baseUrl = (process.env.NVIDIA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = process.env.NVIDIA_AI_MODEL || DEFAULT_MODEL;

    const prompt = `You are Ruby, the female AI assistant of Crimson Suite, created by Crimson (github.com/crimsonej).
Crimson is currently unavailable / away.
A contact named "${senderName}" just sent this message:
"${incomingText}"

INSTRUCTIONS:
1. If this message is a greeting (e.g. "hi", "hey", "hello", "good morning", "good afternoon", "good evening", "yo", "sup", "how are you", etc.):
   Reply as Ruby. Greet them briefly, let them know Crimson is currently away/unavailable, and ask if there is anything you can help them with. Keep it very brief, polite, and sharp.
2. If this message is NOT a greeting (e.g. statements, questions without greetings, commands, random media/links, spam):
   Respond strictly with: NO_REPLY
Never include markdown headers like "SUITE AI". Just the raw text response.`;

    try {
        const res = await axios.post(
            `${baseUrl}/chat/completions`,
            {
                model,
                messages: [{ role: 'system', content: prompt }],
                temperature: 0.4,
                max_tokens: 256
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );
        const reply = res.data?.choices?.[0]?.message?.content?.trim();
        if (!reply || reply.toUpperCase() === 'NO_REPLY') return null;
        return reply;
    } catch (err) {
        console.error('[RUBY AUTO-RESPOND] Error:', err.message);
        return null;
    }
}

/**
 * Summarize activity logged while Ruby was active in auto-responder mode.
 */
async function summarizeRubyActivity(logs) {
    if (!logs || logs.length === 0) return 'No activity recorded while away.';

    const apiKey = getNvidiaApiKey();
    if (!apiKey) {
        return logs.map((l, i) => `${i + 1}. [${l.senderName || l.sender}]: "${l.incoming}" -> "${l.reply}"`).join('\n');
    }

    const baseUrl = (process.env.NVIDIA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = process.env.NVIDIA_AI_MODEL || DEFAULT_MODEL;

    const logLines = logs.map((l, i) => `${i + 1}. Contact: ${l.senderName || l.sender}\n   Message: "${l.incoming}"\n   Ruby Reply: "${l.reply}"`).join('\n\n');

    const prompt = `You are Ruby, the female AI assistant of Crimson Suite (created by Crimson).
Crimson just returned and turned off your auto-responder mode.
Here is the log of messages and interactions you handled while Crimson was away:

${logLines}

Provide a concise, sharp executive briefing summarizing:
• Total contacts who reached out
• Key inquiries or requests from each contact
• Any important action items or follow-ups for Crimson
Be very brief and structured.`;

    try {
        const res = await axios.post(
            `${baseUrl}/chat/completions`,
            {
                model,
                messages: [{ role: 'system', content: prompt }],
                temperature: 0.3,
                max_tokens: 512
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 35000
            }
        );
        return res.data?.choices?.[0]?.message?.content?.trim() || 'Summary unavailable.';
    } catch (err) {
        console.error('[RUBY SUMMARY] Error:', err.message);
        return logs.map((l, i) => `${i + 1}. [${l.senderName || l.sender}]: "${l.incoming}" -> "${l.reply}"`).join('\n');
    }
}

module.exports = {
    askAI,
    generateImage,
    getAIStatus,
    recordAiMessageId,
    isAiMessage,
    clearAIHistory,
    hasActiveConversation,
    recordConversationExchange,
    generateAutoResponse,
    summarizeRubyActivity,
    DEFAULT_MODEL,
    DEFAULT_BASE_URL,
    DEFAULT_IMAGE_INVOKE_URL
};

