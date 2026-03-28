export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const key = process.env.FRED_API_KEY;

  if (!key) {
    res.status(500).json({ error: "No API key found" });
    return;
  }

const series = [
    "BAMLH0A0HYM2",
    "BAMLC0A0CM",
    "T10Y2Y",
    "FEDFUNDS",
    "NFCI",
    "SAHMREALTIME",
    "CPIAUCSL",
    "T10YIE",
    "WALCL",
    "ECBASSETSW",
    "JPNASSETS",
    "CHASSETS"
  ];

  const results = {};

  for (const id of series) {
    const url = "https://api.stlouisfed.org/fred/series/observations?series_id=" + id + "&api_key=" + key + "&sort_order=desc&limit=1&file_type=json";
    const r = await fetch(url);
    const json = await r.json();
    const val = json.observations && json.observations[0] ? json.observations[0].value : null;
    results[id] = val === "." ? null : val;
  }

  res.status(200).json(results);
}
