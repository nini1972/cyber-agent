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
    // Basic origin check
    const origin = req.headers.origin || req.headers.referer || "";
    if (allowedOrigins.length > 0 && origin) {
        const originOnly = origin.replace(/\/(?:.*)$/, "");
        if (!allowedOrigins.includes(originOnly) && !allowedOrigins.includes(origin)) {
            return res.status(403).json({ error: "Origin not allowed" });
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
        const resp = await fetch("https://api.openai.com/v1/realtime/sessions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ model: "gpt-4o-realtime-preview-2024-12-17", voice: "shimmer" }),
        });

        if (!resp.ok) {
            const text = await resp.text();
            return res.status(502).json({ error: "OpenAI realtime session creation failed", detail: text });
        }

        const data = await resp.json();

        // Attach developer-provided or default instructions to the session response
        const defaultInstructions =
            process.env.SESSION_INSTRUCTIONS ||
            "Je bent een vriendelijke, beknopte cyberpunk AI-agent. Reageer in het Nederlands, wees behulpzaam, kort en concreet. Geef geen API-sleutels of persoonlijke data.";
        data.instructions = defaultInstructions;

        return res.status(200).json(data);
    } catch (err) {
        return res.status(500).json({ error: err?.message ?? String(err) });
    }
}