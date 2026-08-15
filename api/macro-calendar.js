// Vercel Serverless Function: /api/macro-calendar?year=2026&month=8
// Fast schedule-only endpoint. Keeps the monthly grid reliable by avoiding
// 15-20 observation requests on every calendar load. Event values are loaded
// lazily from /api/macro-event only when the user clicks a release.

const FRED_BASE = "https://api.stlouisfed.org/fred";
const FRED_API_KEY = process.env.FRED_API_KEY || process.env.FRED_KEY || process.env.FRED_APIKEY || "";
const CACHE_MS = 6 * 60 * 60 * 1000;
const releaseCache = new Map();

const RELEASES = [
  { id: 10, label: "Consumer Price Index", short: "CPI / Core CPI", time: "8:30 AM", category: "Inflation", impact: "High", source: "BLS", officialUrl: "https://www.bls.gov/cpi/" },
  { id: 46, label: "Producer Price Index", short: "PPI", time: "8:30 AM", category: "Inflation", impact: "Medium", source: "BLS", officialUrl: "https://www.bls.gov/ppi/" },
  { id: 50, label: "Employment Situation", short: "Nonfarm Payrolls", time: "8:30 AM", category: "Labor", impact: "High", source: "BLS", officialUrl: "https://www.bls.gov/news.release/empsit.toc.htm" },
  { id: 192, label: "Job Openings and Labor Turnover Survey", short: "JOLTS Job Openings", time: "10:00 AM", category: "Labor", impact: "Medium", source: "BLS", officialUrl: "https://www.bls.gov/jlt/" },
  { id: 180, label: "Unemployment Insurance Weekly Claims Report", short: "Initial Jobless Claims", time: "8:30 AM", category: "Labor", impact: "Low", source: "DOL", officialUrl: "https://www.dol.gov/ui/data.pdf" },
  { id: 9, label: "Advance Monthly Sales for Retail and Food Services", short: "Retail Sales", time: "8:30 AM", category: "Growth", impact: "Medium", source: "Census", officialUrl: "https://www.census.gov/retail/index.html" },
  { id: 53, label: "Gross Domestic Product", short: "GDP", time: "8:30 AM", category: "Growth", impact: "High", source: "BEA", officialUrl: "https://www.bea.gov/data/gdp/gross-domestic-product" },
  { id: 54, label: "Personal Income and Outlays", short: "PCE / Core PCE", time: "8:30 AM", category: "Inflation", impact: "High", source: "BEA", officialUrl: "https://www.bea.gov/data/income-saving/personal-income" },
  { id: 26, label: "Manufacturing ISM Report on Business", short: "ISM Manufacturing", time: "10:00 AM", category: "Survey", impact: "Medium", source: "ISM", officialUrl: "https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/" },
  { id: 13, label: "G.17 Industrial Production and Capacity Utilization", short: "Industrial Production", time: "9:15 AM", category: "Growth", impact: "Medium", source: "Federal Reserve", officialUrl: "https://www.federalreserve.gov/releases/g17/" }
];

const FOMC_DATES = {
  2025: ["2025-01-29","2025-03-19","2025-05-07","2025-06-18","2025-07-30","2025-09-17","2025-10-29","2025-12-10"],
  2026: ["2026-01-28","2026-03-18","2026-04-29","2026-06-17","2026-07-29","2026-09-16","2026-10-28","2026-12-09"],
  2027: ["2027-01-27","2027-03-17","2027-04-28","2027-06-09","2027-07-28","2027-09-15","2027-10-27","2027-12-08"]
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
}

async function fetchReleaseDates(releaseId) {
  const cached = releaseCache.get(releaseId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.dates;
  if (!FRED_API_KEY) throw new Error("Missing FRED_API_KEY in Vercel environment variables");

  const qs = new URLSearchParams({
    release_id: String(releaseId),
    api_key: FRED_API_KEY,
    file_type: "json",
    include_release_dates_with_no_data: "true",
    limit: "10000",
    sort_order: "desc"
  });

  const r = await fetch(`${FRED_BASE}/release/dates?${qs.toString()}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error_code) throw new Error(body.error_message || `FRED release ${releaseId} HTTP ${r.status}`);

  const dates = Array.isArray(body.release_dates)
    ? body.release_dates.map(x => x && x.date).filter(Boolean)
    : [];

  releaseCache.set(releaseId, { at: Date.now(), dates });
  return dates;
}

function isInMonth(date, year, month) {
  return typeof date === "string" && date.startsWith(`${year}-${String(month).padStart(2,"0")}-`);
}

function impactRank(x) { return x === "High" ? 0 : x === "Medium" ? 1 : 2; }

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  try {
    const now = new Date();
    const year = Number((req.query && req.query.year) || now.getFullYear());
    const month = Number((req.query && req.query.month) || (now.getMonth() + 1));

    if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: "Use year=YYYY and month=1..12" });
    }

    const settled = await Promise.allSettled(RELEASES.map(async cfg => ({ cfg, dates: await fetchReleaseDates(cfg.id) })));
    const events = [];
    const warnings = [];

    settled.forEach((result, i) => {
      const cfg = RELEASES[i];
      if (result.status !== "fulfilled") {
        warnings.push(`${cfg.short}: ${result.reason && result.reason.message ? result.reason.message : "release dates unavailable"}`);
        return;
      }

      result.value.dates.filter(d => isInMonth(d, year, month)).forEach(date => {
        events.push({
          id: `fred-${cfg.id}-${date}`,
          date,
          time: cfg.time,
          timezone: "ET",
          title: cfg.short,
          fullTitle: cfg.label,
          category: cfg.category,
          impact: cfg.impact,
          source: cfg.source,
          sourceType: "FRED release calendar",
          sourceUrl: cfg.officialUrl,
          fredUrl: `https://fred.stlouisfed.org/release?rid=${cfg.id}`,
          releaseId: cfg.id,
          actual: null,
          forecast: null,
          previous: null,
          surprisePct: null,
          previousSurprisePct: null
        });
      });
    });

    (FOMC_DATES[year] || []).filter(d => isInMonth(d, year, month)).forEach(date => {
      events.push({
        id: `fomc-${date}`,
        date,
        time: "2:00 PM",
        timezone: "ET",
        title: "FOMC Rate Decision",
        fullTitle: "Federal Open Market Committee Policy Decision",
        category: "Fed",
        impact: "High",
        source: "Federal Reserve",
        sourceType: "Official FOMC meeting calendar",
        sourceUrl: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
        actual: null,
        forecast: null,
        previous: null,
        surprisePct: null,
        previousSurprisePct: null
      });
    });

    events.sort((a,b) => a.date.localeCompare(b.date) || impactRank(a.impact) - impactRank(b.impact) || a.time.localeCompare(b.time));

    return res.status(200).json({
      year,
      month,
      timezone: "America/New_York",
      events,
      warnings,
      sourceSummary: "FRED release calendar + Federal Reserve FOMC schedule",
      dataMode: "schedule-only; values load on click",
      updatedAt: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : "Macro calendar failed" });
  }
}
