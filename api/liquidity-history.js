// File path in your portfolio-proxy-ja56 repo: api/liquidity-history.js
// Fetches historical central bank balance sheet data + S&P 500 for overlay
// WALCL = Fed total assets ($M, weekly)
// ECBASSETSW = ECB total assets (€M, weekly)
// BOJTOTASSETS = Bank of Japan total assets (¥100M, monthly)
// ^GSPC = S&P 500 (daily)
// PBoC doesn't have a clean FRED series, so we approximate using CHNGDPNQDSMEI or leave out.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  // IMPORTANT: Set FRED_API_KEY as a Vercel environment variable in your proxy project
  const FRED_KEY = process.env.FRED_API_KEY;
  if (!FRED_KEY) {
    res.status(500).json({ error: "FRED_API_KEY env var not set" });
    return;
  }

  // 10 years of history — frontend can filter down
  const start = new Date();
  start.setFullYear(start.getFullYear() - 10);
  const startStr = start.toISOString().slice(0, 10);

  async function fetchFred(seriesId) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&observation_start=${startStr}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`FRED ${seriesId} HTTP ${r.status}`);
    const j = await r.json();
    return (j.observations || [])
      .filter(o => o.value && o.value !== ".")
      .map(o => ({ date: o.date, value: parseFloat(o.value) }));
  }

  async function fetchYahoo(symbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1mo`;
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" }
    });
    if (!r.ok) throw new Error(`Yahoo ${symbol} HTTP ${r.status}`);
    const j = await r.json();
    const result = j.chart?.result?.[0];
    if (!result) return [];
    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const out = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] == null) continue;
      out.push({
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        value: closes[i]
      });
    }
    return out;
  }

  try {
    const [fed, ecb, boj, sp500] = await Promise.all([
      fetchFred("WALCL").catch(e => ({ error: e.message })),
      fetchFred("ECBASSETSW").catch(e => ({ error: e.message })),
      fetchFred("BOJTOTASSETS").catch(e => ({ error: e.message })),
      fetchYahoo("%5EGSPC").catch(e => ({ error: e.message })),
    ]);

    // Normalize all series to USD trillions
    // WALCL is in $M → divide by 1,000,000 to get $T
    // ECBASSETSW is in €M → divide by 1,000,000 and multiply by ~1.08 EUR/USD avg
    // BOJTOTASSETS is in ¥100M (hundred-million yen, "億") → × 1e8 to get yen, × 0.0067 USD/JPY, ÷ 1e12 for trillions = × 6.7e-7
    const fedT = Array.isArray(fed) ? fed.map(d => ({ date: d.date, value: +(d.value / 1_000_000).toFixed(3) })) : [];
    const ecbT = Array.isArray(ecb) ? ecb.map(d => ({ date: d.date, value: +(d.value / 1_000_000 * 1.08).toFixed(3) })) : [];
    const bojT = Array.isArray(boj) ? boj.map(d => ({ date: d.date, value: +(d.value * 0.00000067).toFixed(3) })) : [];
    const spx = Array.isArray(sp500) ? sp500.map(d => ({ date: d.date, value: +d.value.toFixed(2) })) : [];

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");
    res.status(200).json({
      fed: fedT,
      ecb: ecbT,
      boj: bojT,
      sp500: spx,
      note: "Values in USD trillions. SP500 is raw index level.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
