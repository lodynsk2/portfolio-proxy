// File path in your portfolio-proxy-ja56 repo: api/portfolio.js
// Fetches 6 months of daily OHLC for a list of tickers from Yahoo Finance
// Computes: price, 50/200 DMA, RSI(14), Z-score, 6M return, trend, phase
// Query: ?tickers=AVGO,VST,MSFT,...

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const tickerParam = req.query.tickers || "";
  const tickers = tickerParam.split(",").filter(Boolean).slice(0, 25);
  if (tickers.length === 0) return res.status(400).json({ error: "No tickers provided" });

  async function fetchYahoo(symbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`;
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" }
    });
    if (!r.ok) return null;
    const j = await r.json();
    const result = j.chart?.result?.[0];
    if (!result) return null;
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    // Use adjclose if available, fall back to close
    const adjArr = result.indicators?.adjclose?.[0]?.adjclose;
    const closes = adjArr || q.close || [];
    const highs = q.high || [];
    const lows = q.low || [];
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] == null) continue;
      out.push({ t: ts[i], c: closes[i], h: highs[i] || closes[i], l: lows[i] || closes[i] });
    }
    return out;
  }

  function computeMA(candles, period) {
    if (candles.length < period) return null;
    let sum = 0;
    for (let i = candles.length - period; i < candles.length; i++) sum += candles[i].c;
    return +(sum / period).toFixed(2);
  }

  function computeRSI(candles, period = 14) {
    if (candles.length < period + 1) return null;
    // Wilder's smoothed RSI — seed with SMA, then apply EMA smoothing
    var firstGains = 0, firstLosses = 0;
    for (var i = 1; i <= period; i++) {
      var diff = candles[i].c - candles[i - 1].c;
      if (diff > 0) firstGains += diff; else firstLosses -= diff;
    }
    var avgGain = firstGains / period;
    var avgLoss = firstLosses / period;
    // Apply Wilder smoothing for remaining candles
    for (var j = period + 1; j < candles.length; j++) {
      var d = candles[j].c - candles[j - 1].c;
      avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    var rs = avgGain / avgLoss;
    return +(100 - 100 / (1 + rs)).toFixed(1);
  }

  function computeZScore(candles, period = 63) {
    const n = Math.min(period, candles.length);
    if (n < 10) return null;
    const slice = candles.slice(-n).map(c => c.c);
    const mean = slice.reduce((a, b) => a + b, 0) / n;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    if (std === 0) return 0;
    return +((candles[candles.length - 1].c - mean) / std).toFixed(2);
  }

  function computeTQ(candles, period = 63) {
    // Trend Quality: R-squared of linear regression on closes
    const n = Math.min(period, candles.length);
    if (n < 10) return null;
    const slice = candles.slice(-n).map(c => c.c);
    const xMean = (n - 1) / 2;
    const yMean = slice.reduce((a, b) => a + b, 0) / n;
    let ssXY = 0, ssXX = 0, ssTot = 0;
    for (let i = 0; i < n; i++) {
      ssXY += (i - xMean) * (slice[i] - yMean);
      ssXX += (i - xMean) ** 2;
      ssTot += (slice[i] - yMean) ** 2;
    }
    if (ssTot === 0 || ssXX === 0) return 50;
    const slope = ssXY / ssXX;
    const ssRes = ssTot - (ssXY ** 2) / ssXX;
    const rSquared = 1 - ssRes / ssTot;
    // Scale to 0-100, direction matters
    const direction = slope >= 0 ? 1 : -1;
    return +(rSquared * 100 * direction).toFixed(1);
  }

  function analyze(candles) {
    if (!candles || candles.length < 50) return null;
    const last = candles[candles.length - 1].c;
    const ma50 = computeMA(candles, 50);
    const ma200 = computeMA(candles, 200);
    const rsi = computeRSI(candles);
    const zScore = computeZScore(candles);
    const tq = computeTQ(candles);
    
    // 6M return
    const idx6m = Math.max(0, candles.length - 126);
    const r6m = +((last / candles[idx6m].c - 1) * 100).toFixed(1);
    
    // MA deviation (% from 50 DMA)
    const maDev = ma50 ? +((last / ma50 - 1) * 100).toFixed(1) : null;
    
    // Trend
    let trend = "Neutral";
    if (ma50 && ma200) {
      if (last > ma50 && last > ma200) trend = "Bullish";
      else if (last < ma50 && last < ma200) trend = "Bearish";
      else trend = "Neutral";
    }
    
    // Phase
    let phase = "Steady";
    if (trend === "Bearish" && maDev && maDev < -10) phase = "Broken Trend";
    else if (trend === "Bearish" && maDev && maDev < -3) phase = "Deterioration";
    else if (trend === "Bullish" && zScore && zScore > 2) phase = "Vertical Phase";
    else if (trend === "Bullish") phase = "Steady";
    else phase = "Consolidation";
    
    // Action
    let action = "Hold";
    if (phase === "Broken Trend") action = "Close";
    else if (phase === "Deterioration") action = "Close";
    else if (phase === "Vertical Phase" && zScore > 2.5) action = "Scale Out";
    else if (trend === "Bullish" && rsi < 70) action = "Hold";
    else if (trend === "Bullish" && rsi >= 70) action = "Scale Out";
    
    return {
      price: +last.toFixed(2),
      ma50, ma200, rsi, zScore, tq: tq ? Math.abs(tq) : null,
      r6m, maDev, trend, phase, action,
    };
  }

  try {
    const results = {};
    await Promise.all(tickers.map(async (t) => {
      try {
        const candles = await fetchYahoo(t);
        results[t] = analyze(candles);
      } catch (e) {
        results[t] = { error: e.message };
      }
    }));

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate");
    res.status(200).json({ holdings: results, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
