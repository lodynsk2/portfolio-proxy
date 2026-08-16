// Stable SEC Financials endpoint for Vercel
// Save as: /api/sec-financials.js
// Primary target: U.S. domestic SEC filers using 10-K / 10-Q and US-GAAP XBRL.
// Set SEC_CONTACT in Vercel, e.g. "PortfolioManager you@example.com".

const SEC_BASE = "https://data.sec.gov";
const SEC_WWW = "https://www.sec.gov";
const UA = process.env.SEC_CONTACT || "PortfolioManager financial-dashboard contact@example.com";
const DAY = 24 * 60 * 60 * 1000;
let tickerCache = null;
let tickerCacheAt = 0;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
}

function secHeaders() {
  return {
    "User-Agent": UA,
    "Accept": "application/json",
    "Accept-Encoding": "gzip, deflate"
  };
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: secHeaders() });
  if (!r.ok) throw new Error(`SEC request failed ${r.status}: ${url}`);
  return r.json();
}

async function tickerMap() {
  if (tickerCache && Date.now() - tickerCacheAt < DAY) return tickerCache;
  const raw = await fetchJson(`${SEC_WWW}/files/company_tickers.json`);
  const map = {};
  Object.values(raw || {}).forEach((x) => {
    if (x && x.ticker) map[String(x.ticker).toUpperCase()] = x;
  });
  tickerCache = map;
  tickerCacheAt = Date.now();
  return map;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function getUnitRows(fact, unit) {
  if (!fact || !fact.units) return [];
  if (unit && fact.units[unit]) return fact.units[unit];
  return [];
}

function annualRows(fact, unit) {
  const byEnd = new Map();
  for (const x of getUnitRows(fact, unit)) {
    if (!x || !x.start || !x.end || !/^(10-K|10-K\/A)$/.test(x.form || "")) continue;
    const d = daysBetween(x.start, x.end);
    if (d == null || d < 250 || d > 450) continue;
    const prev = byEnd.get(x.end);
    if (!prev || String(x.filed || "") > String(prev.filed || "")) byEnd.set(x.end, x);
  }
  return [...byEnd.values()].sort((a, b) => String(a.end).localeCompare(String(b.end)));
}

function annualInstantRows(fact, unit) {
  const byEnd = new Map();
  for (const x of getUnitRows(fact, unit)) {
    if (!x || !x.end || !/^(10-K|10-K\/A)$/.test(x.form || "")) continue;
    const prev = byEnd.get(x.end);
    if (!prev || String(x.filed || "") > String(prev.filed || "")) byEnd.set(x.end, x);
  }
  return [...byEnd.values()].sort((a,b)=>String(a.end).localeCompare(String(b.end)));
}

function latestInstant(fact, unit) {
  const rows = getUnitRows(fact, unit).filter((x) =>
    x && x.end && /^(10-K|10-K\/A|10-Q|10-Q\/A)$/.test(x.form || "")
  );
  rows.sort((a, b) =>
    String(a.end).localeCompare(String(b.end)) ||
    String(a.filed || "").localeCompare(String(b.filed || ""))
  );
  return rows.length ? rows[rows.length - 1] : null;
}

function itemVal(x) {
  return x && Number.isFinite(Number(x.val)) ? Number(x.val) : null;
}

function factCandidates(facts, names) {
  const tax = (facts && facts["us-gaap"]) || {};
  return names.filter((name) => tax[name]).map((name) => ({ name, fact: tax[name] }));
}

// Critical reliability rule: choose the concept whose annual series has the NEWEST period end.
// This prevents legacy tags from winning simply because they contain more old history.
function bestAnnualConcept(facts, names, unit) {
  let best = null;
  for (const c of factCandidates(facts, names)) {
    const rows = annualRows(c.fact, unit);
    if (!rows.length) continue;
    const latest = rows[rows.length - 1].end || "";
    if (
      !best ||
      latest > best.latest ||
      (latest === best.latest && rows.length > best.rows.length)
    ) {
      best = { name: c.name, fact: c.fact, rows, latest };
    }
  }
  return best;
}

function bestAnnualInstantConcept(facts, names, unit) {
  let best = null;
  for (const c of factCandidates(facts, names)) {
    const rows = annualInstantRows(c.fact, unit);
    if (!rows.length) continue;
    const latest = rows[rows.length - 1].end || "";
    if (!best || latest > best.latest || (latest === best.latest && rows.length > best.rows.length)) {
      best = { name:c.name, fact:c.fact, rows, latest };
    }
  }
  return best;
}

function bestInstantConcept(facts, names, unit) {
  let best = null;
  for (const c of factCandidates(facts, names)) {
    const x = latestInstant(c.fact, unit);
    if (!x) continue;
    if (
      !best ||
      String(x.end) > String(best.row.end) ||
      (String(x.end) === String(best.row.end) && String(x.filed || "") > String(best.row.filed || ""))
    ) {
      best = { name: c.name, fact: c.fact, row: x };
    }
  }
  return best;
}

function mapByEnd(best) {
  return new Map((best && best.rows ? best.rows : []).map((x) => [x.end, x]));
}

function valueAt(map, end) {
  return itemVal(map && map.get(end));
}

function pickLatestInterim(fact, unit, afterAnnualEnd) {
  const rows = getUnitRows(fact, unit).filter((x) => {
    if (!x || !x.start || !x.end || !/^(10-Q|10-Q\/A)$/.test(x.form || "")) return false;
    if (afterAnnualEnd && x.end <= afterAnnualEnd) return false;
    const d = daysBetween(x.start, x.end);
    return d != null && d >= 60 && d <= 300;
  });
  if (!rows.length) return null;
  const newestEnd = rows.map((x) => x.end).sort().slice(-1)[0];
  const same = rows.filter((x) => x.end === newestEnd);
  // Prefer the longest duration for the latest end date. This makes Q2/Q3
  // a YTD statement period when the filing supplies both quarter-only and YTD
  // facts, which also aligns operating cash flow and CapEx on a consistent basis.
  // For equal durations, prefer the latest filed fact.
  same.sort((a, b) =>
    (daysBetween(b.start, b.end) || 0) - (daysBetween(a.start, a.end) || 0) ||
    String(b.filed || "").localeCompare(String(a.filed || ""))
  );
  return same[0] || null;
}

function classifyProfile(sub) {
  const sic = Number(sub && sub.sic) || 0;
  if (sic >= 6000 && sic <= 6799) return "financial";
  return "standard";
}

function sourceUrls(cik) {
  const padded = String(cik).padStart(10, "0");
  return [
    { label: "SEC Company Facts", url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`, type: "SEC" },
    { label: "SEC Submissions", url: `https://data.sec.gov/submissions/CIK${padded}.json`, type: "SEC" }
  ];
}

function countPeriodValues(periods) {
  const keys = ["revenue", "grossProfit", "ebitda", "operatingIncome", "netIncome", "eps", "operatingCashFlow", "capex", "freeCashFlow"];
  return (periods || []).reduce((n, p) => n + keys.reduce((m, k) => m + (p && p[k] != null ? 1 : 0), 0), 0);
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  try {
    let ticker = String((req.query && req.query.ticker) || "").trim().toUpperCase();
    if (!ticker) return res.status(400).json({ error: "ticker is required" });

    const requestedTicker = ticker;
    const map = await tickerMap();
    let meta = map[ticker];
    if (!meta && ticker.includes(".")) {
      ticker = ticker.replace(/\./g, "-");
      meta = map[ticker];
    }
    if (!meta) return res.status(404).json({ error: `Ticker ${requestedTicker} not found in SEC ticker list` });

    const cik = String(meta.cik_str).padStart(10, "0");
    const [cf, sub] = await Promise.all([
      fetchJson(`${SEC_BASE}/api/xbrl/companyfacts/CIK${cik}.json`),
      fetchJson(`${SEC_BASE}/submissions/CIK${cik}.json`)
    ]);
    const facts = cf.facts || {};
    const recentForms = (sub && sub.filings && sub.filings.recent && sub.filings.recent.form) || [];
    const hasDomesticAnnual = recentForms.some((f) => /^(10-K|10-K\/A)$/.test(String(f || "")));
    const hasForeignAnnual = recentForms.some((f) => /^(20-F|20-F\/A|40-F|40-F\/A)$/.test(String(f || "")));
    if (!hasDomesticAnnual && hasForeignAnnual) {
      return res.status(422).json({
        error: "Foreign private issuer detected. This audited endpoint currently supports U.S.-GAAP 10-K/10-Q filers; 20-F/40-F issuers are intentionally withheld rather than mapped unreliably."
      });
    }

    const revenueBest = bestAnnualConcept(facts, [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "Revenues",
      "SalesRevenueNet",
      "SalesRevenueGoodsNet",
      "SalesRevenueServicesNet"
    ], "USD");
    if (!revenueBest) return res.status(422).json({ error: "No usable recent annual revenue XBRL facts were found" });

    const annualBase = revenueBest.rows.slice(-5);
    const annualEnds = annualBase.map((x) => x.end);
    const latestAnnualEnd = annualEnds[annualEnds.length - 1];

    const concepts = {
      grossProfit: bestAnnualConcept(facts, ["GrossProfit"], "USD"),
      operatingIncome: bestAnnualConcept(facts, ["OperatingIncomeLoss"], "USD"),
      netIncome: bestAnnualConcept(facts, ["NetIncomeLoss", "ProfitLoss"], "USD"),
      eps: bestAnnualConcept(facts, ["EarningsPerShareDiluted"], "USD/shares"),
      ocf: bestAnnualConcept(facts, ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"], "USD"),
      capex: bestAnnualConcept(facts, ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsForAdditionsToPropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"], "USD"),
      da: bestAnnualConcept(facts, ["DepreciationDepletionAndAmortization", "DepreciationDepletionAndAmortizationPropertyPlantAndEquipment", "Depreciation"], "USD"),
      interestExpense: bestAnnualConcept(facts, ["InterestExpenseNonOperating", "InterestAndDebtExpense"], "USD")
    };

    const maps = { revenue: mapByEnd(revenueBest) };
    Object.keys(concepts).forEach((k) => { maps[k] = mapByEnd(concepts[k]); });

    const historical = annualBase.map((base) => {
      const end = base.end;
      const fy = base.fy != null && Number.isFinite(Number(base.fy)) ? Number(base.fy) : Number(end.slice(0, 4));
      const revenue = valueAt(maps.revenue, end);
      const op = valueAt(maps.operatingIncome, end);
      const da = valueAt(maps.da, end);
      const ocf = valueAt(maps.ocf, end);
      const capexRaw = valueAt(maps.capex, end);
      const capex = capexRaw == null ? null : Math.abs(capexRaw);
      return {
        year: fy,
        fiscalYear: fy,
        fiscalPeriod: base.fp || "FY",
        periodLabel: `FY ${fy}`,
        periodType: "FY",
        periodEnd: end,
        form: base.form || null,
        filed: base.filed || null,
        revenue,
        grossProfit: valueAt(maps.grossProfit, end),
        ebitda: op != null && da != null ? op + da : null,
        operatingIncome: op,
        netIncome: valueAt(maps.netIncome, end),
        eps: valueAt(maps.eps, end),
        operatingCashFlow: ocf,
        capex,
        freeCashFlow: ocf != null && capex != null ? ocf - capex : null,
        interestExpense: valueAt(maps.interestExpense, end)
      };
    });

    let currentPeriod = null;
    const interimRevenue = pickLatestInterim(revenueBest.fact, "USD", latestAnnualEnd);
    if (interimRevenue) {
      const r = interimRevenue;
      const duration = daysBetween(r.start, r.end) || 0;
      const periodType = duration > 120 ? "YTD" : "QTD";
      const fy = r.fy != null ? Number(r.fy) : Number(r.end.slice(0, 4));
      const fp = r.fp ? String(r.fp).toUpperCase() : null;

      function getInterim(best, unit) {
        if (!best || !best.fact) return null;
        const rows = getUnitRows(best.fact, unit).filter((x) => x && x.end === r.end && /^(10-Q|10-Q\/A)$/.test(x.form || ""));
        if (!rows.length) return null;
        rows.sort((a, b) =>
          Math.abs((daysBetween(a.start, a.end) || 0) - duration) - Math.abs((daysBetween(b.start, b.end) || 0) - duration) ||
          String(b.filed || "").localeCompare(String(a.filed || ""))
        );
        return itemVal(rows[0]);
      }

      const revenue = itemVal(r);
      const gross = getInterim(concepts.grossProfit, "USD");
      const op = getInterim(concepts.operatingIncome, "USD");
      const ni = getInterim(concepts.netIncome, "USD");
      const eps = getInterim(concepts.eps, "USD/shares");
      const ocf = getInterim(concepts.ocf, "USD");
      const capexRaw = getInterim(concepts.capex, "USD");
      const capex = capexRaw == null ? null : Math.abs(capexRaw);
      const da = getInterim(concepts.da, "USD");
      let label = `${periodType} through ${r.end}`;
      if (fp && /^Q[1-4]$/.test(fp)) label = `${fp} FY${fy}${periodType === "YTD" && fp !== "Q1" ? " YTD" : ""}`;

      currentPeriod = {
        year: fy,
        fiscalYear: fy,
        fiscalPeriod: fp,
        periodLabel: label,
        periodType,
        periodEnd: r.end,
        revenue,
        grossProfit: gross,
        ebitda: op != null && da != null ? op + da : null,
        operatingIncome: op,
        netIncome: ni,
        eps,
        operatingCashFlow: ocf,
        capex,
        freeCashFlow: ocf != null && capex != null ? ocf - capex : null
      };
    }

    function latestMoney(names) {
      const best = bestInstantConcept(facts, names, "USD");
      return best ? itemVal(best.row) : null;
    }

    const cashBest = bestInstantConcept(facts, ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "CashAndDueFromBanks"], "USD");
    const cash = cashBest ? itemVal(cashBest.row) : null;
    const cashBasis = cashBest ? cashBest.name : null;

    // Interest-bearing debt proxy. Prefer a filed total long-term-debt concept;
    // otherwise combine current + noncurrent long-term debt. Short-term
    // borrowings/commercial paper are added separately. We intentionally do
    // not mix generic liabilities into EV.
    const totalLongTermDebt = latestMoney(["LongTermDebtAndFinanceLeaseObligations", "LongTermDebt"]);
    const longTermCurrent = latestMoney(["LongTermDebtAndFinanceLeaseObligationsCurrent", "LongTermDebtCurrent"]);
    const longTermNoncurrent = latestMoney(["LongTermDebtAndFinanceLeaseObligationsNoncurrent", "LongTermDebtNoncurrent"]);
    const shortTermBorrowings = latestMoney(["ShortTermBorrowings", "CommercialPaper"]);
    let longTermDebt = totalLongTermDebt;
    if (longTermDebt == null && (longTermCurrent != null || longTermNoncurrent != null)) {
      longTermDebt = Number(longTermCurrent || 0) + Number(longTermNoncurrent || 0);
    }
    const debt = longTermDebt != null || shortTermBorrowings != null
      ? Number(longTermDebt || 0) + Number(shortTermBorrowings || 0)
      : null;

    const sharesBest = bestInstantConcept(facts, ["CommonStockSharesOutstanding"], "shares");
    let shares = sharesBest ? itemVal(sharesBest.row) : null;
    let sharesAsOf = sharesBest && sharesBest.row ? sharesBest.row.end : null;
    let sharesBasis = shares != null ? "SEC shares outstanding" : null;

    // DEI shares fact lives outside us-gaap, so inspect it separately.
    if (shares == null && facts.dei && facts.dei.EntityCommonStockSharesOutstanding) {
      const x = latestInstant(facts.dei.EntityCommonStockSharesOutstanding, "shares");
      shares = itemVal(x);
      sharesAsOf = x && x.end ? x.end : null;
      sharesBasis = shares != null ? "SEC cover-page shares outstanding" : null;
    }

    const assetsCurrent = latestMoney(["AssetsCurrent"]);
    const liabilitiesCurrent = latestMoney(["LiabilitiesCurrent"]);
    const equityLatest = latestMoney(["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]);
    const assetsLatest = latestMoney(["Assets"]);

    const annualAssetsBest = bestAnnualInstantConcept(facts, ["Assets"], "USD");
    const annualEquityBest = bestAnnualInstantConcept(facts, ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], "USD");
    const annualAssetsMap = new Map((annualAssetsBest&&annualAssetsBest.rows||[]).map(x=>[x.end,x]));
    const annualEquityMap = new Map((annualEquityBest&&annualEquityBest.rows||[]).map(x=>[x.end,x]));

    const profile = classifyProfile(sub);
    const latest = historical[historical.length - 1] || {};
    const prior = historical.length>1 ? historical[historical.length-2] : null;
    const latestAssetsAnnual = latest&&latest.periodEnd ? itemVal(annualAssetsMap.get(latest.periodEnd)) : null;
    const priorAssetsAnnual = prior&&prior.periodEnd ? itemVal(annualAssetsMap.get(prior.periodEnd)) : null;
    const latestEquityAnnual = latest&&latest.periodEnd ? itemVal(annualEquityMap.get(latest.periodEnd)) : null;
    const priorEquityAnnual = prior&&prior.periodEnd ? itemVal(annualEquityMap.get(prior.periodEnd)) : null;
    const avgAssets = latestAssetsAnnual!=null&&priorAssetsAnnual!=null ? (latestAssetsAnnual+priorAssetsAnnual)/2 : null;
    const avgEquity = latestEquityAnnual!=null&&priorEquityAnnual!=null ? (latestEquityAnnual+priorEquityAnnual)/2 : null;
    const latestInterest = latest&&latest.interestExpense!=null ? Math.abs(Number(latest.interestExpense)) : null;
    const ratios = {
      grossMargin: latest.revenue && latest.grossProfit != null ? latest.grossProfit / latest.revenue * 100 : null,
      operatingMargin: latest.revenue && latest.operatingIncome != null ? latest.operatingIncome / latest.revenue * 100 : null,
      ebitdaMargin: profile === "financial" ? null : (latest.revenue && latest.ebitda != null ? latest.ebitda / latest.revenue * 100 : null),
      netMargin: latest.revenue && latest.netIncome != null ? latest.netIncome / latest.revenue * 100 : null,
      roe: latest.netIncome!=null && avgEquity>0 ? latest.netIncome / avgEquity * 100 : null,
      roa: latest.netIncome!=null && avgAssets>0 ? latest.netIncome / avgAssets * 100 : null,
      roic: null,
      currentRatio: profile === "financial" ? null : (assetsCurrent!=null && liabilitiesCurrent>0 ? assetsCurrent / liabilitiesCurrent : null),
      debtToEquity: profile === "financial" ? null : (debt!=null && equityLatest>0 ? debt / equityLatest : null),
      interestCoverage: profile === "financial" ? null : (latest.operatingIncome!=null && latestInterest>0 ? latest.operatingIncome / latestInterest : null)
    };

    const sameCikTickers = Object.values(map)
      .filter((x) => String(x.cik_str) === String(meta.cik_str))
      .map((x) => String(x.ticker).toUpperCase());
    const multipleShareClasses = sameCikTickers.length > 1;
    const checkedValues = countPeriodValues(historical) + (currentPeriod ? countPeriodValues([currentPeriod]) : 0) + (cash != null ? 1 : 0) + (debt != null ? 1 : 0) + (shares != null ? 1 : 0);

    const latestEndAgeDays = latestAnnualEnd ? Math.round((Date.now() - Date.parse(latestAnnualEnd)) / 86400000) : null;
    const warnings = [];
    if (latestEndAgeDays != null && latestEndAgeDays > 550) warnings.push(`Latest annual period (${latestAnnualEnd}) appears stale.`);
    if (historical.length < 4) warnings.push("Fewer than four annual periods were available.");
    if (multipleShareClasses) warnings.push(`Multiple tickers share this CIK (${sameCikTickers.join(", ")}); price × SEC shares market-cap fallback is disabled.`);
    const sharesAgeDays = sharesAsOf ? Math.round((Date.now() - Date.parse(sharesAsOf)) / 86400000) : null;
    const sharesRecentEnough = shares != null && (sharesAgeDays == null || sharesAgeDays <= 550);
    if (shares != null && !sharesRecentEnough) warnings.push(`Shares-outstanding fact is stale (${sharesAsOf}); price × shares market-cap fallback is disabled.`);

    const recent = (sub && sub.filings && sub.filings.recent) || {};
    const latestFiled = recent.filingDate && recent.filingDate[0] ? recent.filingDate[0] : null;

    return res.status(200).json({
      ticker,
      requestedTicker,
      name: cf.entityName || meta.title || ticker,
      sector: null,
      industry: sub && sub.sicDescription ? sub.sicDescription : null,
      sic: sub && sub.sic ? sub.sic : null,
      currency: "USD",
      profile,
      fiscalYearEnd: sub && sub.fiscalYearEnd ? sub.fiscalYearEnd : null,
      financialValuesScale: 1,
      shareValuesScale: 1,
      currentPrice: null,
      marketCap: null,
      enterpriseValue: null,
      pe: null,
      evEbitda: null,
      dividendYield: null,
      cash,
      cashBasis,
      debt,
      debtBasis: debt == null ? null : "SEC interest-bearing debt proxy (long-term debt plus short-term borrowings when separately available)",
      assets: assetsLatest,
      equity: equityLatest,
      currentAssets: assetsCurrent,
      currentLiabilities: liabilitiesCurrent,
      shares,
      sharesAsOf,
      sharesBasis,
      sharesApproximate: false,
      listedTickers: sameCikTickers,
      multipleShareClasses,
      marketCapDerivationAllowed: !multipleShareClasses && sharesRecentEnough,
      evMetricsMeaningful: profile !== "financial",
      dcfComparableToQuote: !multipleShareClasses && sharesRecentEnough,
      historical,
      currentPeriod,
      ratios,
      validation: {
        status: warnings.length ? "WARN" : "PASS",
        warnings,
        checkedValues
      },
      selectedConcepts: {
        revenue: revenueBest.name,
        revenueLatestEnd: revenueBest.latest
      },
      sources: sourceUrls(cik),
      verifiedAsOf: new Date().toISOString().slice(0, 10),
      retrievedAsOf: new Date().toISOString(),
      latestSECFiledDate: latestFiled,
      dataMethod: "SEC Company Facts deterministic U.S.-issuer extraction",
      scope: "U.S. domestic 10-K/10-Q filers using US-GAAP XBRL",
      unsupportedIssuerPolicy: "Foreign private issuers and unsupported taxonomies are withheld rather than approximated.",
      ebitdaBasis: "Derived proxy = operating income + depreciation/depletion/amortization when both are available from SEC XBRL; not necessarily company-reported adjusted EBITDA.",
      metricNotes: profile === "financial" ? "Financial-institution profile: generic EV/EBITDA, current ratio, debt/equity and interest-coverage comparisons are intentionally withheld; gross-profit/EBITDA concepts may also be unavailable." : "Standard corporate profile; EBITDA is a filing-derived proxy when available, ROE/ROA use average beginning/end annual balance-sheet denominators and remain blank when the prior annual denominator is unavailable; ROIC is left blank unless a defensible invested-capital definition is available, and debt is an interest-bearing-debt proxy rather than total liabilities."
    });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : "SEC financials failed" });
  }
}
