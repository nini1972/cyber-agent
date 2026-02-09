import OpenAI from "openai";

// Simple in-memory rate limiter (per origin/ip) and origin whitelist.
// Note: serverless instances are ephemeral; for production use a centralized store.
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 8; // max requests per window

// Read allowed origins from env or fallback to common values
const DEFAULT_ALLOWED = [
    `https://cyber-agent-rho.vercel.app`,
    `http://localhost:3000`,
    `http://127.0.0.1:3000`,
];
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ALLOWED;

// Vercel Serverless handler that verifies the API key and returns a small status
// Replace the body with your desired OpenAI calls (ephemeral key creation, etc.).
export default async function handler(req, res) {
    // Basic origin check (robust): normalize origin or referer, allow partial matches,
    // and return helpful debug info on failure so it's easy to fix allowed origins.
    const rawOrigin = (req.headers.origin || req.headers.referer || "").toString();
    if (allowedOrigins.length > 0 && rawOrigin) {
        let originToCheck = rawOrigin;
        try {
            // If referer is a full URL, extract its origin
            if (originToCheck && originToCheck.includes('://')) {
                originToCheck = new URL(originToCheck).origin;
            }
        } catch (e) {
            // keep rawOrigin if URL parsing fails
            originToCheck = rawOrigin;
        }

        const normalizedAllowed = allowedOrigins.map((a) => a.replace(/\/$/, '').toLowerCase());
        const normalizedOrigin = originToCheck.replace(/\/$/, '').toLowerCase();

        const ok = normalizedAllowed.some((a) => {
            // allow exact origin, or origin that starts with allowed entry
            if (!a) return false;
            if (normalizedOrigin === a) return true;
            if (normalizedOrigin.startsWith(a)) return true;
            // also allow matching by hostname only (strip protocol)
            const aHost = a.replace(/^https?:\/\//, '');
            if (normalizedOrigin.includes(aHost)) return true;
            return false;
        });

        if (!ok) {
            // Return origin and allowed list to help debugging (no secrets here)
            return res.status(403).json({ error: "Origin not allowed", origin: originToCheck, allowed: normalizedAllowed });
        }
    }

    // Simple rate-limit per origin/IP
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || origin || "unknown").toString();
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    const timestamps = (rateLimitMap.get(ip) || []).filter((t) => t >= windowStart);
    if (timestamps.length >= RATE_LIMIT_MAX) {
        res.setHeader("Retry-After", Math.ceil(RATE_LIMIT_WINDOW_MS / 1000));
        return res.status(429).json({ error: "Too many requests" });
    }
    timestamps.push(now);
    rateLimitMap.set(ip, timestamps);

    // Ensure this file runs server-side (under /api). If you see "process is not defined"
    // it means this file was executed in a runtime without Node globals (or bundled client-side).
    const apiKey = process?.env?.OPENAI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: "OPENAI_API_KEY niet ingesteld in Vercel" });
    }

    try {
        // Create an ephemeral session using the Realtime API so the client can connect
        // Endpoint: POST https://api.openai.com/v1/realtime/sessions
        // Add a small timeout and retry loop because occasionally the OpenAI endpoint
        // can return 5xx/504 from Cloudflare. We retry a couple times with backoff.
        const FETCH_TIMEOUT_MS = 15000; // 15s
        const MAX_SESSION_RETRIES = 2;

        async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const resp = await fetch(url, { ...opts, signal: controller.signal });
                return resp;
            } finally {
                clearTimeout(id);
            }
        }

        let lastErr = null;
        let data = null;
        for (let attempt = 0; attempt <= MAX_SESSION_RETRIES; attempt++) {
            try {
                const resp = await fetchWithTimeout("https://api.openai.com/v1/realtime/sessions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        model: "gpt-4o-realtime-preview-2024-12-17",
                        modalities: ["audio", "text"],

                        // Audio output settings
                        audio: {
                            voice: "shimmer",
                            format: "pcm16",
                            sample_rate: 24000
                        },

                        // Enable phoneme timestamps for lipsync
                        speech: {
                            phoneme_timestamps: true
                        },

                        // Enable server-side VAD (so you can talk naturally)
                        turn_detection: {
                            type: "server_vad"
                        },

                        // Enable transcription of your microphone input
                        input_audio_transcription: {
                            model: "gpt-4o-transcribe"
                        }
                    })

                });

                if (!resp.ok) {
                    const text = await resp.text();
                    lastErr = new Error(`OpenAI session endpoint returned ${resp.status}`);
                    lastErr.detail = text;
                    // For 5xx/504/502 try again up to retries; otherwise break
                    if (resp.status >= 500 && attempt < MAX_SESSION_RETRIES) {
                        const backoff = 500 * Math.pow(2, attempt);
                        await new Promise((r) => setTimeout(r, backoff));
                        continue;
                    }
                    // non-retryable or out of attempts
                    return res.status(502).json({ error: "OpenAI realtime session creation failed", detail: text });
                }

                data = await resp.json();
                break;
            } catch (err) {
                lastErr = err;
                // If aborted/timed out, retry a bit
                if (attempt < MAX_SESSION_RETRIES) {
                    const backoff = 500 * Math.pow(2, attempt);
                    await new Promise((r) => setTimeout(r, backoff));
                    continue;
                }
                // out of attempts
                return res.status(502).json({ error: "OpenAI realtime session creation failed", detail: String(err) });
            }
        }

        // Attach developer-provided or default instructions to the session response
        const defaultInstructions =
            process.env.SESSION_INSTRUCTIONS ||
            "Je bent een cyberpunk AI-agent die hulp biedt bij taken, code en korte conversatie. Wees vriendelijk, helder en beknopt. Reageer primair in het Nederlands; geef korte samenvattingen en concrete next-steps. Noem nooit of geef nooit API-sleutels, wachtwoorden of persoonlijke data. Als de gebruiker iets vraagt buiten je capabilities, geef een heldere reden en een alternatief. Gebruik een levendige, speelse toon maar geen ongepaste taal.";
        data.instructions = defaultInstructions;

        return res.status(200).json(data);
    } catch (err) {
        return res.status(500).json({ error: err?.message ?? String(err) });
    }
}