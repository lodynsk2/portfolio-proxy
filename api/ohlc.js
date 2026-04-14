// File path in your portfolio-proxy-ja56 repo: api/ohlc.js
// Fetches 3 months of daily OHLC for S&P 500, Nasdaq 100, and Bitcoin
// from Yahoo Finance's public chart API (no API key required).

export default async function handler(req, res) {
  // Enable CORS so your dashboard can call this
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  // Symbols: Yahoo Finance format
  // ^GSPC = S&P 500, ^NDX = Nasdaq 100, BTC-USD = Bitcoin
  const symbols = [
    { key: "sp500",   yahoo: "%5EGSPC" },   // ^GSPC encoded
    { key: "nasdaq",  yahoo: "%5ENDX" },    // ^NDX encoded
    { key: "bitcoin", yahoo: "BTC-USD" },
  ];

  try {
    const results = {};

    // Fetch all three in parallel
    await Promise.all(
      symbols.map(async (s) => {
        const url =
          "https://query1.finance.yahoo.com/v8/finance/chart/" +
          s.yahoo +
          "?range=3mo&interval=1d";

        const r = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          },
        });

        if (!r.ok) {
          results[s.key] = { error: "HTTP " + r.status };
          return;
        }

        const json = await r.json();
        const result = json.chart && json.chart.result && json.chart.result[0];
        if (!result) {
          results[s.key] = { error: "no_result" };
          return;
        }

        const timestamps = result.timestamp || [];
        const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
        if (!quote) {
          results[s.key] = { error: "no_quote" };
          return;
        }

        // Build array of {date, high, low, close} rows
        const candles = [];
        for (let i = 0; i < timestamps.length; i++) {
          const h = quote.high[i], l = quote.low[i], c = quote.close[i];
          if (h == null || l == null || c == null) continue;
          candles.push({
            t: timestamps[i],
            h: Number(h.toFixed(2)),
            l: Number(l.toFixed(2)),
            c: Number(c.toFixed(2)),
          });
        }

        results[s.key] = { candles };
      })
    );

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate");
    res.status(200).json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
