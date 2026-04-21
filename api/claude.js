// File path in your portfolio-proxy-ja56 repo: api/claude.js
// (keeping the filename so the frontend doesn't need URL changes)
// Routes to Google Gemini API (free tier) instead of Anthropic.
// Requires environment variable: GEMINI_API_KEY
// Get your free key at: https://aistudio.google.com/apikey

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY env var not set. Get a free key at https://aistudio.google.com/apikey" });
  }

  try {
    const body = req.body;
    if (!body || !body.messages) {
      return res.status(400).json({ error: "Missing messages in request body" });
    }

    // Convert Anthropic message format to Gemini format
    const geminiContents = body.messages.map(function(msg) {
      return {
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }]
      };
    });

    const model = "gemini-2.0-flash";
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;

    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: geminiContents,
        generationConfig: {
          maxOutputTokens: body.max_tokens || 1000,
          temperature: 0.7,
        },
      }),
    });

    const geminiData = await geminiRes.json();

    if (!geminiRes.ok) {
      return res.status(geminiRes.status).json({
        error: "Gemini API error",
        status: geminiRes.status,
        detail: geminiData,
      });
    }

    // Convert Gemini response to Anthropic-compatible format
    // so the frontend parsing code works without changes
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";

    const anthropicFormat = {
      content: [{ type: "text", text: text }],
      model: model,
      stop_reason: "end_turn",
    };

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(anthropicFormat);
  } catch (err) {
    return res.status(500).json({
      error: "Proxy error: " + err.message,
    });
  }
}
