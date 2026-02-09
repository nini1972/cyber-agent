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
        const client = new OpenAI({ apiKey });

        // Optional: you can perform a light, non-costly check here. For now respond OK.
        return res.status(200).json({ ok: true });
    } catch (err) {
        return res.status(500).json({ error: err?.message ?? String(err) });
    }
}