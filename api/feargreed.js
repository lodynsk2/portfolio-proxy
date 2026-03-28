export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const results = {};

  // Crypto Fear & Greed (Alternative.me - free, no key needed)
  try {
    const cryptoRes = await fetch("https://api.alternative.me/fng/?limit=2");
    const cryptoJson = await cryptoRes.json();
    const latest = cryptoJson.data?.[0];
    const previous = cryptoJson.data?.[1];
    if (latest) {
      results.cryptoScore = parseInt(latest.value);
      results.cryptoLabel = latest.value_classification;
      results.cryptoPrev = previous ? parseInt(previous.value) : null;
    }
  } catch(e) {
    results.cryptoError = e.message;
  }

  // Stock Market Fear & Greed — calculated from market indicators
  // Uses VIX, S&P momentum, junk bond demand, safe haven demand
  try {
    const symbols = ["^VIX", "^GSPC", "^TNX"];
    const quotes = await Promise.all(symbols.map(async (sym) => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=3mo`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const j = await r.json();
      const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(Boolean);
      return { sym, closes };
    }));

    const bySymbol = {};
    quotes.forEach(q => { bySymbol[q.sym] = q.closes; });

    const vixCloses = bySymbol["^VIX"];
    const spCloses = bySymbol["^GSPC"];
    const tnxCloses = bySymbol["^TNX"];

    let score = 50; // start neutral
    const components = {};

    // 1. VIX component (lower VIX = more greed)
    if (vixCloses?.length > 0) {
      const vix = vixCloses[vixCloses.length - 1];
      const vixAvg = vixCloses.slice(-63).reduce((a,b) => a+b, 0) / Math.min(63, vixCloses.length);
      const vixScore = Math.max(0, Math.min(100, 100 - ((vix / vixAvg - 0.7) / 0.8) * 100));
      components.vix = Math.round(vixScore);
      score += (vixScore - 50) * 0.25;
    }

    // 2. S&P momentum vs 125-day MA
    if (spCloses?.length > 0) {
      const sp = spCloses[spCloses.length - 1];
      const ma125 = spCloses.slice(-Math.min(63, spCloses.length)).reduce((a,b) => a+b, 0) / Math.min(63, spCloses.length);
      const pctAbove = ((sp - ma125) / ma125) * 100;
      const momentumScore = Math.max(0, Math.min(100, 50 + pctAbove * 3));
      components.momentum = Math.round(momentumScore);
      score += (momentumScore - 50) * 0.25;
    }

    // 3. Safe haven demand (bond yield rising = less safe haven demand = greed)
    if (tnxCloses?.length > 0) {
      const tnx = tnxCloses[tnxCloses.length - 1];
      const tnxPrev = tnxCloses[Math.max(0, tnxCloses.length - 20)];
      const yieldChange = tnx - tnxPrev;
      const safeHavenScore = Math.max(0, Math.min(100, 50 - yieldChange * 20));
      components.safeHaven = Math.round(safeHavenScore);
      score += (safeHavenScore - 50) * 0.25;
    }

    // 4. S&P 5-day momentum
    if (spCloses?.length >= 5) {
      const sp = spCloses[spCloses.length - 1];
      const sp5d = spCloses[spCloses.length - 5];
      const ret5d = ((sp - sp5d) / sp5d) * 100;
      const ret5dScore = Math.max(0, Math.min(100, 50 + ret5d * 5));
      components.shortMomentum = Math.round(ret5dScore);
      score += (ret5dScore - 50) * 0.25;
    }

    const finalScore = Math.max(0, Math.min(100, Math.round(score)));

    const getLabel = (s) => {
      if (s <= 25) return "Extreme Fear";
      if (s <= 44) return "Fear";
      if (s <= 55) return "Neutral";
      if (s <= 75) return "Greed";
      return "Extreme Greed";
    };

    results.cnnScore = finalScore;
    results.cnnLabel = getLabel(finalScore);
    results.cnnComponents = components;

  } catch(e) {
    results.cnnError = e.message;
  }

  res.status(200).json(results);
}
