const axios = require('axios');
const https = require('https');
const http = require('http');

// ── Persistent HTTP agents for connection reuse (saves ~300-500ms TLS handshake per request) ──
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 30000 });
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 30000 });

// Create a reusable axios instance with keep-alive
const aiClient = axios.create({
    httpAgent: keepAliveHttpAgent,
    httpsAgent: keepAliveHttpsAgent
});

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const DEFAULT_IMAGE_INVOKE_URL = 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b';

function getNvidiaApiKey() {
    return (process.env.NVIDIA_API_KEY || '').trim();
}

// Conversation memory per chat
// Map of chatJid -> Array<{ role: 'user' | 'assistant', content: string, timestamp: number }>
const chatHistories = new Map();
const MAX_HISTORY_MESSAGES = 10; // Up to 5 full conversational exchanges (fewer = faster inference)
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
 * Clean raw text from HTML tags and common entities
 */
function cleanHtmlText(text) {
    if (!text) return '';
    return text
        .replace(/<[^>]+>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Lightweight web search via DuckDuckGo (Lite HTML, Standard HTML, and Instant Answer API).
 * Free, fast, and does not require any paid API keys.
 * Returns Array<{ title?: string, snippet: string, url?: string }>
 */
async function searchWeb(query) {
    if (!query || typeof query !== 'string') return [];
    const cleanQuery = query.trim().slice(0, 160);
    if (!cleanQuery) return [];

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
    };

    // Strategy 1: DuckDuckGo HTML Lite (plain tables, fastest)
    try {
        const bodyParams = new URLSearchParams({ q: cleanQuery }).toString();
        const liteRes = await aiClient.post(
            'https://lite.duckduckgo.com/lite/',
            bodyParams,
            {
                headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 5000
            }
        );
        const html = String(liteRes.data || '');
        const results = [];
        const linkMatches = [...html.matchAll(/<a[^>]+class=["']result-link["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
        const snippetMatches = [...html.matchAll(/<td[^>]+class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/gi)];

        for (let i = 0; i < Math.min(snippetMatches.length, 5); i++) {
            const snippet = cleanHtmlText(snippetMatches[i][1]);
            const title = linkMatches[i] ? cleanHtmlText(linkMatches[i][2]) : '';
            const url = linkMatches[i] ? linkMatches[i][1] : '';
            if (snippet && snippet.length > 20) {
                results.push({ title, snippet, url });
            }
        }
        if (results.length > 0) return results;
    } catch (e) {
        // Fallback to Strategy 2
    }

    // Strategy 2: DuckDuckGo Standard HTML
    try {
        const htmlRes = await aiClient.get(
            `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`,
            { headers, timeout: 5000 }
        );
        const html = String(htmlRes.data || '');
        const results = [];
        const snippetRegex = /<a[^>]+class=["']result__snippet["'][^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = snippetRegex.exec(html)) !== null && results.length < 5) {
            const snippet = cleanHtmlText(match[1]);
            if (snippet && snippet.length > 20) {
                results.push({ snippet });
            }
        }
        if (results.length > 0) return results;
    } catch (e) {
        // Fallback to Strategy 3
    }

    // Strategy 3: DuckDuckGo Instant Answer API (JSON)
    try {
        const apiRes = await aiClient.get(
            `https://api.duckduckgo.com/?q=${encodeURIComponent(cleanQuery)}&format=json&no_html=1&skip_disambig=1`,
            { headers, timeout: 4000 }
        );
        const data = apiRes.data;
        const results = [];
        if (data?.AbstractText) {
            results.push({
                title: data.Heading || cleanQuery,
                snippet: data.AbstractText,
                url: data.AbstractURL || ''
            });
        }
        if (Array.isArray(data?.RelatedTopics)) {
            for (const topic of data.RelatedTopics.slice(0, 3)) {
                if (topic.Text) {
                    results.push({
                        title: topic.FirstURL || cleanQuery,
                        snippet: topic.Text,
                        url: topic.FirstURL || ''
                    });
                }
            }
        }
        if (results.length > 0) return results;
    } catch (e) {
        // Search unavailable
    }

    return [];
}

/**
 * Determine if a prompt benefits from live online web search.
 */
function shouldSearchWeb(prompt) {
    if (!prompt || typeof prompt !== 'string') return false;
    const lower = prompt.toLowerCase();

    // Explicit requests to search / find / look up
    if (/^(?:search|google|lookup|look up|browse|find info(?: on)?)\b/i.test(lower)) return true;
    if (/\b(?:search for|search online|search the web|google it|look it up|check online)\b/i.test(lower)) return true;

    // Temporal markers indicating real-time info needs
    const temporalRegex = /\b(current(?:ly)?|up[ -]to[ -]date|as of now|right now|latest|recent|newest|today|yesterday|tomorrow|this week|this month|this year|breaking news|live|standings|release date|who won|election results|weather in|price of|stock price|crypto price|exchange rate)\b/i;
    if (temporalRegex.test(lower)) return true;

    // References to current & future years (post-cutoff)
    if (/\b(202[4-9]|203[0-9])\b/.test(lower)) return true;

    return false;
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
    const currentYear = new Date().getFullYear();

    const systemPrompt = `You are Ruby, a female AI built into Crimson Suite by Crimson (github.com/crimsonej). Be very brief, sharp, and precise. Only answer what is asked. Current year is ${currentYear}. No fluff.`;

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

    // Live Web Search injection if applicable or requested
    const needsSearch = options.forceSearch || (options.webSearch !== false && shouldSearchWeb(prompt));
    if (needsSearch) {
        try {
            const searchQuery = prompt
                .replace(/^(?:search(?:\s+for|\s+online|\s+the\s+web)?|google|lookup|look\s+up)\s+/i, '')
                .replace(/\b(?:ruby|please|can you|tell me|what is|what's)\b/gi, '')
                .trim();

            const searchResults = await searchWeb(searchQuery || prompt);
            if (searchResults && searchResults.length > 0) {
                const formattedSnippets = searchResults
                    .map((r, i) => `[${i + 1}] ${r.title ? r.title + ': ' : ''}${r.snippet}${r.url ? ` (Source: ${r.url})` : ''}`)
                    .join('\n');
                const currentDate = new Date().toISOString().slice(0, 10);
                messages.push({
                    role: 'system',
                    content: `[LIVE WEB SEARCH RESULTS - Date: ${currentDate}]\nQuery: "${searchQuery || prompt}"\n${formattedSnippets}\n\nInstructions: Treat these as current web results, use them to answer the user's question, and cite the provided source URLs when useful. Do not claim you lack live access when results are provided. If the results do not establish a fact, say what could not be verified.`
                });
            } else {
                messages.push({
                    role: 'system',
                    content: `[LIVE WEB SEARCH UNAVAILABLE - Date: ${new Date().toISOString().slice(0, 10)}]\nA live search was attempted for "${searchQuery || prompt}" but returned no usable results. Do not present remembered information as verified current information or claim a search succeeded. Briefly tell the user current details could not be verified right now.`
                });
            }
        } catch (searchErr) {
            console.error('[AI WEB SEARCH] Warning:', searchErr.message);
        }
    }

    // Append prior conversational turns (trim long messages to reduce token count)
    for (const h of history) {
        messages.push({
            role: h.role,
            content: h.content.length > 300 ? h.content.slice(0, 300) + '…' : h.content
        });
    }

    // If external context was quoted from another message and history is empty
    if (options.context && history.length === 0) {
        messages.push({
            role: 'user',
            content: `Context: ${options.context}`
        });
    }

    // Cap very long prompts to avoid slow inference
    const trimmedPrompt = prompt.length > 1500 ? prompt.slice(0, 1500) + '…' : prompt;
    messages.push({
        role: 'user',
        content: trimmedPrompt
    });

    const endpoint = `${baseUrl}/chat/completions`;
    const res = await aiClient.post(
        endpoint,
        {
            model,
            messages,
            temperature: 0.5,
            top_p: 0.9,
            max_tokens: 16384
        },
        {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 45000
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

    const res = await aiClient.post(
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
            const testRes = await aiClient.get(`${baseUrl}/models`, {
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

    const prompt = `You are Ruby, female AI of Crimson Suite (by Crimson). Crimson is away.
"${senderName}" sent: "${incomingText.slice(0, 500)}"
If it's a greeting (hi/hey/hello/good morning/etc): reply briefly as Ruby, say Crimson is away, ask how you can help.
If NOT a greeting: respond only with NO_REPLY
No markdown headers. Raw text only.`;

    try {
        const res = await aiClient.post(
            `${baseUrl}/chat/completions`,
            {
                model,
                messages: [{ role: 'system', content: prompt }],
                temperature: 0.4,
                max_tokens: 128
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 20000
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
        const res = await aiClient.post(
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
    searchWeb,
    shouldSearchWeb,
    DEFAULT_MODEL,
    DEFAULT_BASE_URL,
    DEFAULT_IMAGE_INVOKE_URL
};

