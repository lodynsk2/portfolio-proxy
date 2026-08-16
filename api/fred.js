// Audited FRED endpoint for Vercel: /api/fred
// Required env var: FRED_API_KEY
// Returns transparent, transformed macro series used by the Portfolio Manager.

const BASE = "https://api.stlouisfed.org/fred/series/observations";
const KEY = process.env.FRED_API_KEY || process.env.FRED_KEY || process.env.FRED_APIKEY || "";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
}

async function obs(seriesId, options = {}) {
  if (!KEY) throw new Error("Missing FRED_API_KEY in Vercel environment variables");
  const qs = new URLSearchParams({
    series_id: seriesId,
    api_key: KEY,
    file_type: "json",
    sort_order: "desc",
    limit: String(options.limit || 8),
  });
  if (options.units) qs.set("units", options.units);
  if (options.frequency) qs.set("frequency", options.frequency);
  if (options.aggregation_method) qs.set("aggregation_method", options.aggregation_method);
  const r = await fetch(`${BASE}?${qs.toString()}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error_code) throw new Error(j.error_message || `${seriesId} HTTP ${r.status}`);
  return (Array.isArray(j.observations) ? j.observations : [])
    .map(x => ({ date: x.date, value: x.value === "." ? null : Number(x.value) }))
    .filter(x => x.date && Number.isFinite(x.value));
}

function latest(rows, i = 0) {
  return rows && rows[i] ? rows[i].value : null;
}
function dateOf(rows, i = 0) {
  return rows && rows[i] ? rows[i].date : null;
}
function atOrBefore(rows, targetDate) {
  if (!Array.isArray(rows) || !targetDate) return null;
  // obs() returns rows newest-first; choose the newest FX observation on or
  // before the balance-sheet observation date.
  const row = rows.find(x => x && x.date <= targetDate && Number.isFinite(x.value));
  return row ? row.value : null;
}
function str(v, d = 2) {
  return Number.isFinite(v) ? Number(v).toFixed(d) : null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  try {
    const specs = {
      GDP: ["A191RL1Q225SBEA", {}],              // Real GDP q/q annualized %
      CPI: ["CPIAUCSL", { units: "pc1", limit: 14 }], // CPI % change from year ago
      CORE_CPI: ["CPILFESL", { units: "pc1", limit: 14 }],
      FED: ["FEDFUNDS", {}],
      CURVE: ["T10Y2Y", {}],
      HY: ["BAMLH0A0HYM2", {}],
      SAHM: ["SAHMREALTIME", {}],
      NFCI: ["NFCI", {}],
      BEI10: ["T10YIE", {}],
      M2: ["M2SL", {}],
      WALCL: ["WALCL", {}],
      ECB: ["ECBASSETSW", {}],
      BOJ: ["JPNASSETS", {}],
      EURUSD: ["DEXUSEU", { limit: 70 }],         // USD per EUR
      JPYUSD: ["DEXJPUS", { limit: 70 }],         // JPY per USD
      INDPRO: ["INDPRO", { units: "pch", limit: 6 }],
    };

    const keys = Object.keys(specs);
    const settled = await Promise.allSettled(keys.map(k => obs(specs[k][0], specs[k][1])));
    const data = {};
    const warnings = [];
    settled.forEach((r, i) => {
      const k = keys[i];
      if (r.status === "fulfilled") data[k] = r.value;
      else { data[k] = []; warnings.push(`${k}: ${r.reason && r.reason.message ? r.reason.message : "unavailable"}`); }
    });

    const gdp = latest(data.GDP), gdpPrev = latest(data.GDP, 1);
    const cpi = latest(data.CPI), cpiPrev = latest(data.CPI, 1);
    const coreCpi = latest(data.CORE_CPI), coreCpiPrev = latest(data.CORE_CPI, 1);
    const fed = latest(data.FED), fedPrev = latest(data.FED, 1);
    const m2 = latest(data.M2), m2Prev = latest(data.M2, 1);
    const walcl = latest(data.WALCL), walclPrev = latest(data.WALCL, 1);
    const ecb = latest(data.ECB), ecbPrev = latest(data.ECB, 1);
    const boj = latest(data.BOJ), bojPrev = latest(data.BOJ, 1);
    const ecbDate = dateOf(data.ECB), ecbPrevDate = dateOf(data.ECB, 1);
    const bojDate = dateOf(data.BOJ), bojPrevDate = dateOf(data.BOJ, 1);
    const eurusd = atOrBefore(data.EURUSD, ecbDate);
    const eurusdPrev = atOrBefore(data.EURUSD, ecbPrevDate);
    const jpyPerUsd = atOrBefore(data.JPYUSD, bojDate);
    const jpyPerUsdPrev = atOrBefore(data.JPYUSD, bojPrevDate);

    // Central-bank balance-sheet proxy in USD trillions.
    // WALCL: USD millions; ECBASSETSW: EUR millions; JPNASSETS: 100 million yen.
    // FX is aligned to each ECB/BoJ observation date rather than applying today's
    // FX rate to both current and prior balance-sheet observations.
    function cbProxy(fedM, ecbM, boj100m, eurUsdAtDate, jpyPerUsdAtDate) {
      if (![fedM, ecbM, boj100m, eurUsdAtDate, jpyPerUsdAtDate].every(Number.isFinite) || jpyPerUsdAtDate === 0) return null;
      const fedT = fedM / 1e6;
      const ecbT = (ecbM * eurUsdAtDate) / 1e6;
      const bojT = boj100m / (1e4 * jpyPerUsdAtDate);
      return fedT + ecbT + bojT;
    }
    const cb = cbProxy(walcl, ecb, boj, eurusd, jpyPerUsd);
    const cbPrev = cbProxy(walclPrev, ecbPrev, bojPrev, eurusdPrev, jpyPerUsdPrev);

    return res.status(200).json({
      // Backward-compatible names, but values are correctly transformed.
      GDPC1: str(gdp, 2),
      GDPC1_PREV: str(gdpPrev, 2),
      GDP_GROWTH: str(gdp, 2),
      GDP_GROWTH_PREV: str(gdpPrev, 2),
      GDP_GROWTH_DATE: dateOf(data.GDP),

      CPIAUCSL: str(cpi, 2),
      CPI_PREV: str(cpiPrev, 2),
      CPI_YOY: str(cpi, 2),
      CPI_YOY_PREV: str(cpiPrev, 2),
      CPI_DATE: dateOf(data.CPI),
      CORE_CPI_YOY: str(coreCpi, 2),
      CORE_CPI_YOY_PREV: str(coreCpiPrev, 2),

      FEDFUNDS: str(fed, 2),
      FEDFUNDS_PREV: str(fedPrev, 2),
      FEDFUNDS_DATE: dateOf(data.FED),
      T10Y2Y: str(latest(data.CURVE), 2),
      T10Y2Y_DATE: dateOf(data.CURVE),
      BAMLH0A0HYM2: str(latest(data.HY), 2),
      BAMLH0A0HYM2_DATE: dateOf(data.HY),
      SAHMREALTIME: str(latest(data.SAHM), 2),
      SAHMREALTIME_DATE: dateOf(data.SAHM),
      NFCI: str(latest(data.NFCI), 3),
      NFCI_DATE: dateOf(data.NFCI),
      T10YIE: str(latest(data.BEI10), 2),
      T10YIE_DATE: dateOf(data.BEI10),

      M2SL: str(m2, 1),
      M2SL_PREV: str(m2Prev, 1),
      M2SL_DATE: dateOf(data.M2),
      WALCL: str(walcl, 0),
      WALCL_PREV: str(walclPrev, 0),
      ECBASSETSW: str(ecb, 0),
      ECBASSETSW_PREV: str(ecbPrev, 0),
      JPNASSETS: str(boj, 0),
      JPNASSETS_PREV: str(bojPrev, 0),
      DEXUSEU: str(eurusd, 4),
      DEXUSEU_PREV: str(eurusdPrev, 4),
      DEXJPUS: str(jpyPerUsd, 2),
      DEXJPUS_PREV: str(jpyPerUsdPrev, 2),
      CB_PROXY_USD_T: str(cb, 2),
      CB_PROXY_USD_T_PREV: str(cbPrev, 2),
      INDPRO_MOM: str(latest(data.INDPRO), 2),
      INDPRO_DATE: dateOf(data.INDPRO),

      _method: "Audited FRED transforms: GDP q/q annualized, CPI y/y, central-bank assets converted with date-aligned FRED FX observations",
      _retrievedAt: new Date().toISOString(),
      _warnings: warnings,
    });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : "FRED lookup failed" });
  }
}
