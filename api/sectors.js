export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const sectors = [
    { name:"Technology",        etf:"XLK" },
    { name:"Healthcare",        etf:"XLV" },
    { name:"Financials",        etf:"XLF" },
    { name:"Consumer Staples",  etf:"XLP" },
    { name:"Consumer Cyclical", etf:"XLY" },
    { name:"Energy",            etf:"XLE" },
    { name:"Utilities",         etf:"XLU" },
    { name:"Industrials",       etf:"XLI" },
    { name:"Real Estate",       etf:"XLRE" },
    { name:"Materials",         etf:"XLB" },
    { name:"Communication",     etf:"XLC" },
  ];

  try {
    const results = [];

    for (const s of sectors) {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${s.etf}?interval=1d&range=6mo`;
        const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        const json = await r.json();
        const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(Boolean);

        if (closes && closes.length > 0) {
          const current = closes[closes.length - 1];
          const price3mAgo = closes[Math.max(0, closes.length - 63)];
          const price6mAgo = closes[0];
          const r3m = ((current - price3mAgo) / price3mAgo * 100).toFixed(1);
          const r6m = ((current - price6mAgo) / price6mAgo * 100).toFixed(1);
          results.push({
            name: s.name,
            etf: s.etf,
            price: current.toFixed(2),
            r3m: (parseFloat(r3m) >= 0 ? "+" : "") + r3m,
            r6m: (parseFloat(r6m) >= 0 ? "+" : "") + r6m,
            pos: parseFloat(r3m) >= 0
          });
        }
      } catch(e) {
        results.push({ name:s.name, etf:s.etf, r3m:"—", r6m:"—", pos:false });
      }
    }

    // Sort by 6M return descending
    results.sort((a, b) => parseFloat(b.r6m) - parseFloat(a.r6m));

    res.status(200).json({ sectors: results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
