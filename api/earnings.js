// Vercel Serverless Function: /api/earnings?ticker=NVDA
// Uses Alpha Vantage directly (no Anthropic / Claude credits required).
// Required Vercel env var: ALPHA_VANTAGE_API_KEY

const BASE = "https://www.alphavantage.co/query";
const API_KEY = process.env.ALPHA_VANTAGE_API_KEY || "";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
}

function num(v) {
  if (v == null || v === "" || String(v).toLowerCase() === "none") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseCSVLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCSV(text) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]).map(x => x.trim());
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] != null ? vals[i].trim() : ""; });
    return obj;
  });
}

function periodLabel(dateStr, estimated) {
  if (!dateStr || !Number.isFinite(Date.parse(dateStr))) return estimated ? "Next Estimate" : "Reported";
  const d = new Date(dateStr + "T12:00:00Z");
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const yr = String(d.getUTCFullYear()).slice(-2);
  return `${mon} '${yr}${estimated ? "E" : ""}`;
}

async function fetchJSON(url) {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Alpha Vantage HTTP ${r.status}`);
  if (body.Note) throw new Error(body.Note);
  if (body.Information) throw new Error(body.Information);
  if (body["Error Message"]) throw new Error(body["Error Message"]);
  return body;
}

async function fetchText(url) {
  const r = await fetch(url);
  const text = await r.text();
  if (!r.ok) throw new Error(`Alpha Vantage calendar HTTP ${r.status}`);
  return text;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  try {
    if (!API_KEY) {
      return res.status(500).json({
        error: "Missing ALPHA_VANTAGE_API_KEY in Vercel environment variables"
      });
    }

    const ticker = String((req.query && req.query.ticker) || "").trim().toUpperCase();
    if (!ticker) return res.status(400).json({ error: "ticker is required" });

    const earningsUrl =
      `${BASE}?function=EARNINGS&symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(API_KEY)}`;

    const calendarUrl =
      `${BASE}?function=EARNINGS_CALENDAR&symbol=${encodeURIComponent(ticker)}&horizon=3month&apikey=${encodeURIComponent(API_KEY)}`;

    const [earningsResult, calendarResult] = await Promise.allSettled([
      fetchJSON(earningsUrl),
      fetchText(calendarUrl)
    ]);

    if (earningsResult.status !== "fulfilled") {
      throw earningsResult.reason || new Error("Earnings history unavailable");
    }

    const ej = earningsResult.value || {};
    const rawQuarterly = Array.isArray(ej.quarterlyEarnings) ? ej.quarterlyEarnings : [];

    const reported = rawQuarterly
      .map(q => {
        const actual = num(q.reportedEPS);
        const estimate = num(q.estimatedEPS);
        const date = q.reportedDate || q.fiscalDateEnding || null;
        return {
          period: periodLabel(q.fiscalDateEnding || q.reportedDate, false),
          date,
          fiscalDateEnding: q.fiscalDateEnding || null,
          actual,
          estimate,
          surprise: num(q.surprise),
          surprisePct: num(q.surprisePercentage),
          reported: actual != null,
          source: `https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(ticker)}`
        };
      })
      .filter(q => q.reported && q.actual != null)
      .sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0))
      .slice(-6);

    let nextEarningsDate = null;
    let nextEstimate = null;
    let upcoming = null;

    if (calendarResult.status === "fulfilled") {
      const rows = parseCSV(calendarResult.value)
        .filter(r => String(r.symbol || "").toUpperCase() === ticker)
        .filter(r => r.reportDate && Number.isFinite(Date.parse(r.reportDate)))
        .sort((a, b) => Date.parse(a.reportDate) - Date.parse(b.reportDate));

      const now = Date.now() - 86400000;
      const next = rows.find(r => Date.parse(r.reportDate) >= now) || null;

      if (next) {
        nextEarningsDate = next.reportDate || null;
        nextEstimate = num(next.estimate);
        upcoming = {
          period: periodLabel(next.reportDate, true),
          date: next.reportDate,
          actual: null,
          estimate: nextEstimate,
          reported: false,
          source: `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&symbol=${encodeURIComponent(ticker)}`
        };
      }
    }

    const quarters = upcoming ? reported.concat([upcoming]) : reported;

    return res.status(200).json({
      ticker,
      basis: "Alpha Vantage reported EPS / analyst estimate basis",
      nextEarningsDate,
      nextEarningsConfirmed: false,
      nextEstimate,
      dataAsOf: new Date().toISOString().slice(0, 10),
      quarters,
      sources: [
        {
          label: "Alpha Vantage Earnings History",
          url: `https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(ticker)}`
        },
        {
          label: "Alpha Vantage Earnings Calendar",
          url: `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&symbol=${encodeURIComponent(ticker)}`
        }
      ],
      provider: "Alpha Vantage",
      verificationStatus: "DIRECT DATA PROVIDER"
    });
  } catch (e) {
    return res.status(500).json({
      error: e && e.message ? e.message : "Earnings lookup failed"
    });
  }
}
