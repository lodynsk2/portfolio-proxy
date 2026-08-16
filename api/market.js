// Consolidated market-data endpoint for Vercel: /api/market
// No API key is required. Market quotes are delayed where the upstream feed
// requires it. Cboe put/call data is end-of-day market statistics.

const QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote";
const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const CBOE_URL = "https://www.cboe.com/markets/us/options/market-statistics/daily";

const ETF_BREADTH_UNIVERSE = [
  "SPY","IWM","EEM","VUG","VTV","XLY","XLP","XLF","XLU",
  "XLE","XLB","XLV","XLI","XLK","SPHB","SPLV"
];

const SYMBOLS = [
  "^GSPC","^IXIC","BTC-USD","^VIX","DX-Y.NYB","^TNX","^FVX","^IRX","^TYX","^MOVE","ZQ=F",
  ...ETF_BREADTH_UNIVERSE
];

function withTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function computeBreadth(quotes) {
  const bySymbol = Object.fromEntries((quotes || []).map(q => [q.symbol, q]));
  const rows = ETF_BREADTH_UNIVERSE.map(symbol => bySymbol[symbol]).filter(Boolean);
  const usable50 = rows.filter(q => finite(q.regularMarketPrice) != null && finite(q.fiftyDayAverage) != null);
  const usable200 = rows.filter(q => finite(q.regularMarketPrice) != null && finite(q.twoHundredDayAverage) != null);
  const pct50 = usable50.length ? usable50.filter(q => Number(q.regularMarketPrice) > Number(q.fiftyDayAverage)).length / usable50.length * 100 : null;
  const pct200 = usable200.length ? usable200.filter(q => Number(q.regularMarketPrice) > Number(q.twoHundredDayAverage)).length / usable200.length * 100 : null;
  return {
    pct50: pct50 == null ? null : Number(pct50.toFixed(1)),
    pct200: pct200 == null ? null : Number(pct200.toFixed(1)),
    sample50: usable50.length,
    sample200: usable200.length,
    universeSize: ETF_BREADTH_UNIVERSE.length,
    method: "Share of a diversified 16-ETF tracked universe above Yahoo Finance 50-day and 200-day averages"
  };
}

async function fetchCboePutCall() {
  try {
    const r = await withTimeout(CBOE_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`Cboe HTTP ${r.status}`);
    const html = await r.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ");
    const match = text.match(/TOTAL PUT\/CALL RATIO\s+([0-9]+(?:\.[0-9]+)?)/i);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function chartQuote(symbol) {
  const r = await withTimeout(
    `${CHART_URL}/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
    { headers: { "User-Agent": "Mozilla/5.0" } }
  );
  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  const meta = j?.chart?.result?.[0]?.meta;
  const price = finite(meta?.regularMarketPrice);
  const previous = finite(meta?.chartPreviousClose);
  if (price == null) return null;
  return {
    symbol,
    regularMarketPrice: price,
    regularMarketChange: previous == null ? null : price - previous,
    regularMarketChangePercent: previous ? ((price - previous) / previous) * 100 : null,
    regularMarketPreviousClose: previous
  };
}

async function fetchQuotes() {
  const symbols = SYMBOLS.join(",");
  try {
    const r = await withTimeout(
      `${QUOTE_URL}?symbols=${encodeURIComponent(symbols)}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!r.ok) throw new Error(`Yahoo quote HTTP ${r.status}`);
    const data = await r.json();
    const quotes = data?.quoteResponse?.result;
    if (!Array.isArray(quotes) || !quotes.length) throw new Error("Yahoo quote response was empty");
    return { data, warning: null };
  } catch (e) {
    // Keep the core dashboard usable when Yahoo's batch endpoint is unavailable.
    const core = ["^GSPC","^IXIC","BTC-USD","^VIX","DX-Y.NYB","^TNX","^MOVE","ZQ=F"];
    const settled = await Promise.allSettled(core.map(chartQuote));
    const results = settled.map(x => x.status === "fulfilled" ? x.value : null).filter(Boolean);
    return { data: { quoteResponse: { result: results } }, warning: e?.message || "Batch quote feed unavailable" };
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  try {
    const [quoteResult, putCallRatio] = await Promise.all([fetchQuotes(), fetchCboePutCall()]);
    const data = quoteResult.data || { quoteResponse: { result: [] } };
    const quotes = data?.quoteResponse?.result || [];
    const bySymbol = Object.fromEntries(quotes.map(q => [q.symbol, q]));
    const moveIndex = finite(bySymbol["^MOVE"]?.regularMarketPrice);
    const zqPrice = finite(bySymbol["ZQ=F"]?.regularMarketPrice);
    const impliedFedFunds = zqPrice == null ? null : Number((100 - zqPrice).toFixed(3));

    return res.status(200).json({
      ...data,
      analytics: {
        moveIndex,
        breadth: computeBreadth(quotes),
        totalPutCallRatio: putCallRatio,
        forwardPolicy: {
          symbol: "ZQ=F",
          futuresPrice: zqPrice,
          impliedRate: impliedFedFunds,
          label: "Front-month 30-Day Fed Funds futures implied monthly average",
          method: "100 minus the futures price; not a next-meeting probability"
        }
      },
      _sources: {
        quotes: "Yahoo Finance",
        putCall: putCallRatio == null ? null : "Cboe Daily Market Statistics"
      },
      _warning: quoteResult.warning,
      _retrievedAt: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Market lookup failed" });
  }
}
