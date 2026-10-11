const axios = require('axios');

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const DEFAULT_IMAGE_INVOKE_URL = 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b';

function getNvidiaApiKey() {
    return (process.env.NVIDIA_API_KEY || '').trim();
}

/**
 * Ask text questions / prompts to NVIDIA Nemotron model.
 * Responses are strictly concise and not wordy.
 */
async function askAI(prompt, options = {}) {
    const apiKey = getNvidiaApiKey();
    if (!apiKey) {
        throw new Error('NVIDIA_API_KEY is not set. Please set it in your Railway variables or .env file.');
    }

    const baseUrl = (process.env.NVIDIA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = process.env.NVIDIA_AI_MODEL || DEFAULT_MODEL;

    const messages = [
        {
            role: 'system',
            content: 'You are a concise, direct AI assistant. Answer accurately with minimal words. Avoid pleasantries, fluff, or excessive explanation unless requested.'
        }
    ];

    if (options.context) {
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

    return reply.trim();
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
    const model = process.env.NVIDIA_AI_MODEL || DEFAULT_MODEL;
    const baseUrl = (process.env.NVIDIA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const invokeUrl = (process.env.NVIDIA_IMAGE_INVOKE_URL || DEFAULT_IMAGE_INVOKE_URL).trim();

    const imageModelMatch = invokeUrl.match(/genai\/(.+)$/i);
    const imageModel = imageModelMatch ? imageModelMatch[1] : 'flux.2-klein-4b';

    const hasKey = !!apiKey;
    const keyPreview = hasKey ? `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}` : 'Not Set';

    let textStatus = hasKey ? '🟢 Active' : '🔴 Inactive (Key Missing)';
    let imageStatus = hasKey ? `🟢 Active (${imageModel})` : '🔴 Inactive (Key Missing)';

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

    const hostName = baseUrl.replace(/^https?:\/\//, '').split('/')[0];

    return `╔════════════════════════════════╗
║      ✦ *SUITE AI STATUS* ✦      ║
╠════════════════════════════════╣
║ ❯ Model      : ${model}
║ ❯ Text AI    : ${textStatus}
║ ❯ Image Gen  : ${imageStatus}
║ ❯ API Key    : ${keyPreview}
║ ❯ Host       : ${hostName}
╚════════════════════════════════╝
*Commands:*
• \`./ai <prompt>\` — Ask question (concise)
• \`./AI <prompt>\` — Stealth query (no header)
• \`./ai image <prompt>\` — Generate image
• \`./s ./ai image <prompt>\` — Generate sticker`;
}

module.exports = {
    askAI,
    generateImage,
    getAIStatus,
    DEFAULT_MODEL,
    DEFAULT_BASE_URL,
    DEFAULT_IMAGE_INVOKE_URL
};

