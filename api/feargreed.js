// File path in your portfolio-proxy-ja56 repo: api/feargreed.js
// Fetches both CNN Fear & Greed Index and Alternative.me Crypto Fear & Greed Index
// CNN: scrapes the public JSON endpoint at production.dataviz.cnn.io
// Crypto: uses Alternative.me public API
// Returns: { cnnScore, cnnLabel, cryptoScore, cryptoLabel, timestamp, sources }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  function labelFor(score) {
    if (score == null) return null;
    if (score <= 25) return "Extreme Fear";
    if (score <= 44) return "Fear";
    if (score <= 55) return "Neutral";
    if (score <= 75) return "Greed";
    return "Extreme Greed";
  }

  const sources = {};
  let cnnScore = null, cnnLabel = null;
  let cryptoScore = null, cryptoLabel = null;

  // 1) CNN Fear & Greed — public JSON endpoint
  try {
    const cnnUrl = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
    const cnnResp = await fetch(cnnUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Referer": "https://www.cnn.com/markets/fear-and-greed",
      },
    });
    if (cnnResp.ok) {
      const cnnJson = await cnnResp.json();
      if (cnnJson?.fear_and_greed?.score != null) {
        cnnScore = Math.round(cnnJson.fear_and_greed.score);
        cnnLabel = cnnJson.fear_and_greed.rating
          ? cnnJson.fear_and_greed.rating.charAt(0).toUpperCase() + cnnJson.fear_and_greed.rating.slice(1)
          : labelFor(cnnScore);
        sources.cnn = "production.dataviz.cnn.io";
      }
    } else {
      sources.cnn_error = `HTTP ${cnnResp.status}`;
    }
  } catch (e) {
    sources.cnn_error = e.message;
  }

  // 2) Alternative.me Crypto Fear & Greed
  try {
    const altUrl = "https://api.alternative.me/fng/?limit=1&format=json";
    const altResp = await fetch(altUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (altResp.ok) {
      const altJson = await altResp.json();
      const item = altJson?.data?.[0];
      if (item?.value != null) {
        cryptoScore = parseInt(item.value, 10);
        cryptoLabel = (item.value_classification || labelFor(cryptoScore)).toUpperCase();
        sources.crypto = "alternative.me";
      }
    } else {
      sources.crypto_error = `HTTP ${altResp.status}`;
    }
  } catch (e) {
    sources.crypto_error = e.message;
  }

  // Cache 30 minutes server-side, allow stale
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate");

  res.status(200).json({
    cnnScore,
    cnnLabel,
    cryptoScore,
    cryptoLabel,
    timestamp: new Date().toISOString(),
    sources,
  });
}
