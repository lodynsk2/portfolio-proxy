export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const FRED_KEY = process.env.FRED_API_KEY;

  if (!FRED_KEY) {
    return res.status(500).json({ error: "FRED_API_KEY not set" });
  }

  const series = [
    "BAMLH0A0HYM2",  // HY Credit Spread
    "BAMLC0A0CM",    // IG Credit Spread
    "T10Y2Y",        // Yield Curve 10Y-2Y
    "FEDFUNDS",      // Fed Funds Rate
    "NFCI",          // Financial Conditions Index
    "SAHMREALTIME",  // Sahm Rule
    "CPIAUCSL",      // CPI
    "T10YIE",        // 10Y Breakeven Inflation
  ];

  try {
    const results = {};

    await Promise.all(series.map(async (id) => {
      const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${FRED_KEY}&sort_order=desc&limit=2&file_type=json`;
      const r = await fetch(url);
      const json = await r.json();
      const val = json.observations?.[0]?.value;
      results[id] = val === "." ? null : val;
    }));

    res.status(200).json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
```
