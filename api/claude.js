// File path in your portfolio-proxy-ja56 repo: api/claude.js
// Routes to Groq API (free tier, 30 req/min) with Gemini fallback.
// Requires: GROQ_API_KEY (get free at https://console.groq.com/keys)
// Optional: GEMINI_API_KEY as fallback

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const GROQ_KEY = process.env.GROQ_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GROQ_KEY && !GEMINI_KEY) {
    return res.status(500).json({ error: "No AI API key set. Add GROQ_API_KEY (free at console.groq.com/keys) or GEMINI_API_KEY to Vercel env vars." });
  }

  try {
    const body = req.body;
    if (!body || !body.messages) {
      return res.status(400).json({ error: "Missing messages in request body" });
    }

    var text = "";
    var usedProvider = "";

    // Try Groq first (faster, higher limits)
    if (GROQ_KEY) {
      try {
        const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + GROQ_KEY,
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            max_tokens: body.max_tokens || 1000,
            temperature: 0.7,
            messages: body.messages.map(function(m) {
              return { role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) };
            }),
          }),
        });

        if (groqRes.ok) {
          const groqData = await groqRes.json();
          text = groqData.choices?.[0]?.message?.content || "";
          usedProvider = "groq";
        } else if (groqRes.status === 429 && GEMINI_KEY) {
          // Fall through to Gemini
        } else {
          const errData = await groqRes.json().catch(function() { return {}; });
          return res.status(groqRes.status).json({ error: "Groq error", status: groqRes.status, detail: errData });
        }
      } catch (groqErr) {
        if (!GEMINI_KEY) throw groqErr;
        // Fall through to Gemini
      }
    }

    // Fallback to Gemini
    if (!text && GEMINI_KEY) {
      const geminiContents = body.messages.map(function(msg) {
        return {
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }]
        };
      });

      const geminiUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + GEMINI_KEY;
      const geminiRes = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: geminiContents,
          generationConfig: { maxOutputTokens: body.max_tokens || 1000, temperature: 0.7 },
        }),
      });

      if (!geminiRes.ok) {
        const errData = await geminiRes.json().catch(function() { return {}; });
        return res.status(geminiRes.status).json({ error: "Gemini error", status: geminiRes.status, detail: errData });
      }

      const geminiData = await geminiRes.json();
      text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
      usedProvider = "gemini";
    }

    if (!text) {
      return res.status(500).json({ error: "No AI response generated" });
    }

    // Return in Anthropic-compatible format so frontend works unchanged
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      content: [{ type: "text", text: text }],
      model: usedProvider,
      stop_reason: "end_turn",
    });
  } catch (err) {
    return res.status(500).json({ error: "Proxy error: " + err.message });
  }
}
