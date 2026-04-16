// File path in your portfolio-proxy-ja56 repo: api/fred.js
// REPLACE your existing fred.js with this version.
// Adds GDPC1_PREV, CPI_PREV, FEDFUNDS_PREV so frontend can compute MIT macro regime auto-detection.
// Requires environment variable: FRED_API_KEY

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const FRED_API_KEY = process.env.FRED_API_KEY;
  if (!FRED_API_KEY) {
    return res.status(500).json({ error: "FRED_API_KEY env var not set" });
  }

  // Series we need: all current values + historical values for regime detection
  const series = [
    "M2SL",            // US M2 money supply
    "WALCL",           // Fed balance sheet
    "ECBASSETSW",      // ECB balance sheet
    "JPNASSETS",       // BoJ balance sheet
    "BAMLH0A0HYM2",    // High Yield credit spread
    "T10Y2Y",          // 10Y-2Y yield spread
    "FEDFUNDS",        // Fed Funds rate
    "NFCI",            // Chicago Fed National Financial Conditions
    "SAHMREALTIME",    // Sahm Rule recession indicator
    "CPIAUCSL",        // CPI level
    "T10YIE",          // 10Y inflation expectation
    "GDPC1",           // Real GDP
    "UNRATE",          // Unemployment rate
    "VIXCLS",          // VIX
    "SP500",           // S&P 500 (FRED proxy)
    "DTWEXBGS",        // Broad dollar index
  ];

  async function fetchOne(seriesId, prevOffset = 0) {
    // prevOffset = 0 → most recent; prevOffset = 1 → previous obs; etc.
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=20`;
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const j = await r.json();
      const obs = (j.observations || []).filter((o) => o.value !== "." && o.value !== null);
      if (obs.length === 0) return null;
      const target = obs[prevOffset];
      return target ? { value: target.value, date: target.date } : null;
    } catch (e) {
      return null;
    }
  }

  // For year-over-year comparisons (CPI, FEDFUNDS) we need observations ~12 months ago
  async function fetchYearAgo(seriesId) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=15`;
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const j = await r.json();
      const obs = (j.observations || []).filter((o) => o.value !== "." && o.value !== null);
      // For monthly series, the 12th index back is approximately 1 year ago
      const yearAgo = obs[12] || obs[obs.length - 1];
      return yearAgo ? { value: yearAgo.value, date: yearAgo.date } : null;
    } catch (e) {
      return null;
    }
  }

  // For GDP (quarterly), 4 quarters back ≈ year ago
  async function fetchQuartersBack(seriesId, q = 4) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=10`;
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const j = await r.json();
      const obs = (j.observations || []).filter((o) => o.value !== "." && o.value !== null);
      const target = obs[q] || obs[obs.length - 1];
      return target ? { value: target.value, date: target.date } : null;
    } catch (e) {
      return null;
    }
  }

  try {
    // Fetch all current values in parallel
    const out = {};
    await Promise.all(
      series.map(async (s) => {
        const v = await fetchOne(s);
        if (v) {
          out[s] = v.value;
          out[s + "_DATE"] = v.date;
        }
      })
    );

    // Add historical/prev values needed for regime detection & YoY calcs
    const prevPromises = [
      fetchQuartersBack("GDPC1", 4).then((v) => { if (v) { out.GDPC1_PREV = v.value; out.GDPC1_PREV_DATE = v.date; }}),
      fetchYearAgo("CPIAUCSL").then((v) => { if (v) { out.CPI_PREV = v.value; out.CPI_PREV_DATE = v.date; }}),
      fetchYearAgo("FEDFUNDS").then((v) => { if (v) { out.FEDFUNDS_PREV = v.value; out.FEDFUNDS_PREV_DATE = v.date; }}),
      // Previous month M2 for MoM calculation
      fetchOne("M2SL", 1).then((v) => { if (v) { out.M2SL_PREV = v.value; out.M2SL_PREV_DATE = v.date; }}),
    ];
    await Promise.all(prevPromises);

    // Cache 1 hour - FRED data updates daily/weekly/monthly anyway
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");
    res.status(200).json({
      ...out,
      _meta: {
        timestamp: new Date().toISOString(),
        seriesFetched: Object.keys(out).filter((k) => !k.includes("_")).length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
