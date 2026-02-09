import OpenAI from "openai";

// Vercel Serverless handler that verifies the API key and returns a small status
// Replace the body with your desired OpenAI calls (ephemeral key creation, etc.).
export default async function handler(req, res) {
    // Ensure this file runs server-side (under /api). If you see "process is not defined"
    // it means this file was executed in a runtime without Node globals (or bundled client-side).
    const apiKey = process?.env?.OPENAI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: "OPENAI_API_KEY niet ingesteld in Vercel" });
    }

    try {
        // Create a lightweight OpenAI client (safe, no network call yet)
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
        return res.status(200).json(data);
    } catch (err) {
        return res.status(500).json({ error: err?.message ?? String(err) });
    }
}