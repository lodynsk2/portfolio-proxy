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

 // Stock Market Fear & Greed — from feargreedmeter.com
try {
  const fgRes = await fetch("https://feargreedmeter.com/", {
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  const html = await fgRes.text();
  const match = html.match(/currently\s+(?:stands\s+)?at\s+(\d+)/i)
    || html.match(/"score"\s*:\s*(\d+)/i)
    || html.match(/index.*?(\d+).*?Extreme Fear/i);
  if (match) {
    const score = parseInt(match[1]);
    results.cnnScore = score;
    results.cnnLabel = score <= 25 ? "Extreme Fear" : score <= 44 ? "Fear" : score <= 55 ? "Neutral" : score <= 75 ? "Greed" : "Extreme Greed";
  }
} catch(e) {
  results.cnnError = e.message;
}

  res.status(200).json(results);
}
