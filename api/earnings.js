// Vercel Serverless Function: /api/earnings?ticker=NVDA
// Alpha Vantage version with free-tier-safe request pacing.
// Required Vercel env var: ALPHA_VANTAGE_API_KEY

const BASE = "https://www.alphavantage.co/query";
const API_KEY = process.env.ALPHA_VANTAGE_API_KEY || "";

// Warm-instance queue so this function does not fire multiple Alpha Vantage
// requests at the same time. This is especially useful on the free tier.
let avQueue = Promise.resolve();
let lastAvRequestAt = 0;
const MIN_GAP_MS = 1250;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=43200, stale-while-revalidate=86400");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  const lines = String(text || "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);

  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]).map(x => x.trim());

  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = vals[i] != null ? vals[i].trim() : "";
    });
    return obj;
  });
}

function periodLabel(dateStr, estimated) {
  if (!dateStr || !Number.isFinite(Date.parse(dateStr))) {
    return estimated ? "Next Estimate" : "Reported";
  }

  const d = new Date(dateStr + "T12:00:00Z");
  const mon = d.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC"
  });
  const yr = String(d.getUTCFullYear()).slice(-2);

  return `${mon} '${yr}${estimated ? "E" : ""}`;
}

function providerMessage(body) {
  if (!body || typeof body !== "object") return "";
  return body.Note || body.Information || body["Error Message"] || "";
}

function queuedAlphaRequest(task) {
  const run = avQueue.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastAvRequestAt));
    if (wait > 0) await sleep(wait);
    const result = await task();
    lastAvRequestAt = Date.now();
    return result;
  });

  avQueue = run.catch(() => {});
  return run;
}

async function alphaJson(url) {
  return queuedAlphaRequest(async () => {
    const r = await fetch(url);
    const body = await r.json().catch(() => ({}));

    if (!r.ok) throw new Error(`Alpha Vantage HTTP ${r.status}`);

    const msg = providerMessage(body);
    if (msg) throw new Error(msg);

    return body;
  });
}

async function alphaText(url) {
  return queuedAlphaRequest(async () => {
    const r = await fetch(url);
    const text = await r.text();

    if (!r.ok) throw new Error(`Alpha Vantage calendar HTTP ${r.status}`);

    const trimmed = String(text || "").trim();
    if (trimmed.startsWith("{")) {
      const body = JSON.parse(trimmed);
      const msg = providerMessage(body);
      if (msg) throw new Error(msg);
    }

    return text;
  });
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
      `${BASE}?function=EARNINGS&symbol=${encodeURIComponent(ticker)}` +
      `&apikey=${encodeURIComponent(API_KEY)}`;

    const calendarUrl =
      `${BASE}?function=EARNINGS_CALENDAR&symbol=${encodeURIComponent(ticker)}` +
      `&horizon=3month&apikey=${encodeURIComponent(API_KEY)}`;

    // Required call first.
    const ej = await alphaJson(earningsUrl);

    const rawQuarterly = Array.isArray(ej.quarterlyEarnings)
      ? ej.quarterlyEarnings
      : [];

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
          source:
            `https://www.alphavantage.co/query?function=EARNINGS` +
            `&symbol=${encodeURIComponent(ticker)}`
        };
      })
      .filter(q => q.reported && q.actual != null)
      .sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0))
      .slice(-6);

    // Optional second call. If it is rate-limited, history still renders.
    let nextEarningsDate = null;
    let nextEstimate = null;
    let upcoming = null;
    let calendarWarning = null;

    try {
      const calendarText = await alphaText(calendarUrl);

      const rows = parseCSV(calendarText)
        .filter(r => String(r.symbol || "").toUpperCase() === ticker)
        .filter(r => r.reportDate && Number.isFinite(Date.parse(r.reportDate)))
        .sort((a, b) => Date.parse(a.reportDate) - Date.parse(b.reportDate));

      const todayFloor = Date.now() - 86400000;
      const next = rows.find(r => Date.parse(r.reportDate) >= todayFloor) || null;

      if (next) {
        nextEarningsDate = next.reportDate || null;
        nextEstimate = num(next.estimate);

        upcoming = {
          period: periodLabel(next.reportDate, true),
          date: next.reportDate,
          actual: null,
          estimate: nextEstimate,
          reported: false,
          source:
            `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR` +
            `&symbol=${encodeURIComponent(ticker)}`
        };
      }
    } catch (calendarErr) {
      calendarWarning =
        calendarErr && calendarErr.message
          ? calendarErr.message
          : "Upcoming earnings calendar unavailable";
    }

    const quarters = upcoming ? reported.concat([upcoming]) : reported;

    if (!reported.length) {
      return res.status(502).json({
        error: "Alpha Vantage returned no usable quarterly earnings history for " + ticker
      });
    }

    return res.status(200).json({
      ticker,
      basis: "Reported EPS vs analyst estimate (Alpha Vantage)",
      nextEarningsDate,
      nextEarningsConfirmed: false,
      nextEstimate,
      dataAsOf: new Date().toISOString().slice(0, 10),
      quarters,
      sources: [
        {
          label: "Alpha Vantage Earnings History",
          url:
            `https://www.alphavantage.co/query?function=EARNINGS` +
            `&symbol=${encodeURIComponent(ticker)}`
        },
        {
          label: "Alpha Vantage Earnings Calendar",
          url:
            `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR` +
            `&symbol=${encodeURIComponent(ticker)}`
        }
      ],
      provider: "Alpha Vantage",
      verificationStatus: "PROVIDER-SOURCED",
      sourceMethod: "Alpha Vantage EARNINGS history; optional EARNINGS_CALENDAR for upcoming consensus/date",
      providerLimitNote: "Availability and rate limits depend on the connected Alpha Vantage plan; calendar failure does not suppress historical earnings history.",
      calendarWarning
    });
  } catch (e) {
    return res.status(500).json({
      error: e && e.message ? e.message : "Earnings lookup failed"
    });
  }
}
