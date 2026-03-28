export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const results = {};

  // Crypto Fear & Greed (Alternative.me - free, no key)
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

  // CNN Fear & Greed (internal API - free, no key)
  try {
    const today = new Date();
    const weekAgo = new Date(today - 7 * 24 * 60 * 60 * 1000);
    const dateStr = weekAgo.toISOString().split("T")[0];
    const cnnRes = await fetch(
      "https://production.dataviz.cnn.io/index/fearandgreed/graphdata/" + dateStr,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const cnnJson = await cnnRes.json();
    const fgData = cnnJson.fear_and_greed;
    const fgHistory = cnnJson.fear_and_greed_historical?.data;
    if (fgData) {
      results.cnnScore = Math.round(fgData.score);
      results.cnnLabel = fgData.rating;
      results.cnnPrev = fgHistory && fgHistory.length > 1
        ? Math.round(fgHistory[fgHistory.length - 2].y)
        : null;
    }
  } catch(e) {
    results.cnnError = e.message;
  }

  res.status(200).json(results);
}
