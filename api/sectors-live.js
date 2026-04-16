// File path in your portfolio-proxy-ja56 repo: api/sectors-live.js
// Fetches live 1W/1M/3M/6M returns for sector rotation pairs and top 11 S&P sector ETFs
// Uses Yahoo Finance public chart API (no API key required).

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  // All ETFs we need: 6 rotation pairs (12 unique tickers) + 11 sector ETFs
  // Many overlap (SPY, XLY, XLP, XLF, XLU appear in both)
  const tickers = [
    // Sector rotation pairs
    "XLY", "XLP",  // Cyclical vs Defensive
    "IWM", "SPY",  // Small Cap vs Large Cap
    "VUG", "VTV",  // Growth vs Value
    "XLF", "XLU",  // Financials vs Utilities
    "SPHB", "SPLV", // High Beta vs Low Vol
    "EEM",         // Emerging Markets (SPY already above)
    // Top sectors (11 SPDR sector ETFs)
    "XLE", "XLV", "XLI", "XLK", "XLB", "XLRE", "XLC",
  ];
  // Dedupe
  const uniqueTickers = [...new Set(tickers)];

  async function fetchYahoo(symbol) {
    // Get 6 months of daily data — enough to compute 1W/1M/3M/6M returns
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`;
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" }
    });
    if (!r.ok) throw new Error(`Yahoo ${symbol} HTTP ${r.status}`);
    const j = await r.json();
    const result = j.chart?.result?.[0];
    if (!result) return null;
    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const out = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] == null) continue;
      out.push({ t: timestamps[i], c: closes[i] });
    }
    return out;
  }

  // Compute period returns from daily candles
  function computeReturns(candles) {
    if (!candles || candles.length < 5) return null;
    const last = candles[candles.length - 1].c;
    function nDaysAgo(n) {
      const idx = Math.max(0, candles.length - 1 - n);
      return candles[idx].c;
    }
    return {
      r1w:  +((last / nDaysAgo(5)   - 1) * 100).toFixed(2),  // 5 trading days
      r1m:  +((last / nDaysAgo(21)  - 1) * 100).toFixed(2),  // ~21 trading days
      r3m:  +((last / nDaysAgo(63)  - 1) * 100).toFixed(2),  // ~63 trading days
      r6m:  +((last / nDaysAgo(126) - 1) * 100).toFixed(2),  // ~126 trading days
      last: +last.toFixed(2),
    };
  }

  try {
    // Fetch all tickers in parallel
    const results = {};
    await Promise.all(
      uniqueTickers.map(async (t) => {
        try {
          const candles = await fetchYahoo(t);
          results[t] = computeReturns(candles);
        } catch (e) {
          results[t] = { error: e.message };
        }
      })
    );

    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate");
    res.status(200).json({
      tickers: results,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
