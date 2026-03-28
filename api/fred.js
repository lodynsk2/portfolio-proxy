export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const key = process.env.FRED_API_KEY;

  if (!key) {
    res.status(500).json({ error: "No API key found" });
    return;
  }

  const url = "https://api.stlouisfed.org/fred/series/observations?series_id=T10Y2Y&api_key=" + key + "&sort_order=desc&limit=1&file_type=json";

  const r = await fetch(url);
  const json = await r.json();

  res.status(200).json({ test: "ok", data: json });
}
