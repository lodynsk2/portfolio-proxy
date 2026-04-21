// File path in your portfolio-proxy-ja56 repo: api/claude.js
// Proxies requests to the Anthropic Claude API from the browser.
// Requires environment variable: ANTHROPIC_API_KEY

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

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY env var not set. Go to Vercel project Settings > Environment Variables and add it." });
  }

  if (!ANTHROPIC_API_KEY.startsWith("sk-ant-")) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY appears invalid. Should start with sk-ant-. Current value starts with: " + ANTHROPIC_API_KEY.slice(0, 6) + "..." });
  }

  try {
    const body = req.body;
    if (!body || !body.messages) {
      return res.status(400).json({ error: "Missing messages in request body", received: typeof body });
    }

    const payload = {
      model: body.model || "claude-sonnet-4-6",
      max_tokens: body.max_tokens || 1000,
      messages: body.messages,
    };
    if (body.tools) payload.tools = body.tools;

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      return res.status(anthropicRes.status).json({
        error: "Anthropic API error",
        status: anthropicRes.status,
        detail: data,
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({
      error: "Proxy internal error: " + err.message,
    });
  }
}
