export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const symbols = [
    "^GSPC","^VIX","DX-Y.NYB","^TNX","^FVX","^IRX","^TYX",
    "XLY","XLP","IWM","SPY","VUG","VTV","XLF","XLU",
    "SPHB","SPLV","EEM","XLE","XLB","XLV","XLI","XLK"
  ].join(",");

  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!r.ok) {
      const key = ["^GSPC","^VIX","DX-Y.NYB","^TNX"];
      const results = [];
      for (const sym of key) {
        try {
          const cr = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`,
            { headers: { "User-Agent": "Mozilla/5.0" } }
          );
          if (cr.ok) {
            const cj = await cr.json();
            const meta = cj?.chart?.result?.[0]?.meta;
            if (meta) {
              results.push({
                symbol: sym,
                regularMarketPrice: meta.regularMarketPrice,
                regularMarketChange: meta.regularMarketPrice - meta.chartPreviousClose,
                regularMarketChangePercent: ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100,
                regularMarketPreviousClose: meta.chartPreviousClose
              });
            }
          }
        } catch {}
      }
      return res.status(200).json({ quoteResponse: { result: results } });
    }
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
