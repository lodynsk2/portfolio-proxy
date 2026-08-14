// Vercel Serverless Function: /api/sec-financials?ticker=MSFT
// Source of truth: SEC EDGAR Company Facts + submissions APIs.
// Set SEC_CONTACT in Vercel env to a real contact string, e.g. "PortfolioManager your@email.com".

const SEC_BASE = "https://data.sec.gov";
const SEC_WWW = "https://www.sec.gov";
const UA = process.env.SEC_CONTACT || "PortfolioManager financial-dashboard contact@example.com";

let tickerCache = null;
let tickerCacheAt = 0;
const DAY = 24 * 60 * 60 * 1000;

function headers() {
  return { "User-Agent": UA, "Accept-Encoding": "gzip, deflate", "Accept": "application/json" };
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`SEC request failed ${r.status}: ${url}`);
  return r.json();
}

async function tickerMap() {
  if (tickerCache && Date.now() - tickerCacheAt < DAY) return tickerCache;
  const raw = await fetchJson(`${SEC_WWW}/files/company_tickers.json`);
  const map = {};
  Object.values(raw || {}).forEach(x => {
    if (x && x.ticker) map[String(x.ticker).toUpperCase()] = x;
  });
  tickerCache = map; tickerCacheAt = Date.now();
  return map;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function allUnits(fact, unit) {
  if (!fact || !fact.units) return [];
  if (unit && fact.units[unit]) return fact.units[unit];
  const keys = Object.keys(fact.units);
  return keys.length ? fact.units[keys[0]] : [];
}

function firstFact(facts, taxonomy, names) {
  const tax = (facts && facts[taxonomy]) || {};
  for (const n of names) if (tax[n]) return tax[n];
  return null;
}

function annualDurationMap(fact, unit) {
  const out = new Map();
  for (const x of allUnits(fact, unit)) {
    if (!x || !x.end || !/^10-K(?:\/A)?$/.test(x.form || "")) continue;
    const dur = daysBetween(x.start, x.end);
    if (dur == null || dur < 250 || dur > 450) continue;
    const prev = out.get(x.end);
    // Latest-filed representation wins; this also respects subsequent corrections/restatements.
    if (!prev || String(x.filed || "") > String(prev.filed || "")) out.set(x.end, x);
  }
  return out;
}

function annualInstantMap(fact, unit) {
  const out = new Map();
  for (const x of allUnits(fact, unit)) {
    if (!x || !x.end || !/^10-K(?:\/A)?$/.test(x.form || "")) continue;
    const prev = out.get(x.end);
    if (!prev || String(x.filed || "") > String(prev.filed || "")) out.set(x.end, x);
  }
  return out;
}

function latestInstant(fact, unit) {
  const rows = allUnits(fact, unit).filter(x => x && x.end && /^(10-K|10-K\/A|10-Q|10-Q\/A)$/.test(x.form || ""));
  rows.sort((a,b) => String(a.end).localeCompare(String(b.end)) || String(a.filed||"").localeCompare(String(b.filed||"")));
  return rows.length ? rows[rows.length-1] : null;
}

function latestInterimMap(fact, unit, afterEnd) {
  const rows = allUnits(fact, unit).filter(x => {
    if (!x || !x.end || !x.start || !/^10-Q(?:\/A)?$/.test(x.form || "")) return false;
    if (afterEnd && x.end <= afterEnd) return false;
    const d = daysBetween(x.start, x.end);
    return d != null && d >= 60 && d <= 300;
  });
  if (!rows.length) return null;
  const maxEnd = rows.map(x=>x.end).sort().slice(-1)[0];
  const same = rows.filter(x=>x.end===maxEnd);
  // Prefer the longest duration at the newest quarter end (YTD over QTD where both exist).
  same.sort((a,b)=>(daysBetween(a.start,a.end)||0)-(daysBetween(b.start,b.end)||0) || String(a.filed||"").localeCompare(String(b.filed||"")));
  return same[same.length-1] || null;
}

function valueAt(map, end) {
  const x = map && map.get(end);
  return x && Number.isFinite(Number(x.val)) ? Number(x.val) : null;
}

function itemVal(x) { return x && Number.isFinite(Number(x.val)) ? Number(x.val) : null; }

function pickConcept(facts, names, unit) {
  return firstFact(facts, "us-gaap", names) || firstFact(facts, "dei", names);
}

function fiscalYearsFromRevenue(revenueFact) {
  const m = annualDurationMap(revenueFact, "USD");
  return [...m.keys()].sort().slice(-5);
}

function deriveSeries(facts, annualEnds) {
  const concepts = {
    revenue: pickConcept(facts,["RevenueFromContractWithCustomerExcludingAssessedTax","Revenues","SalesRevenueNet","SalesRevenueGoodsNet","SalesRevenueServicesNet"],"USD"),
    grossProfit: pickConcept(facts,["GrossProfit"],"USD"),
    operatingIncome: pickConcept(facts,["OperatingIncomeLoss"],"USD"),
    netIncome: pickConcept(facts,["NetIncomeLoss","ProfitLoss"],"USD"),
    eps: pickConcept(facts,["EarningsPerShareDiluted"],"USD/shares"),
    ocf: pickConcept(facts,["NetCashProvidedByUsedInOperatingActivities","NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],"USD"),
    capex: pickConcept(facts,["PaymentsToAcquirePropertyPlantAndEquipment","PaymentsForAdditionsToPropertyPlantAndEquipment","PaymentsToAcquireProductiveAssets"],"USD"),
    da: pickConcept(facts,["DepreciationDepletionAndAmortization","DepreciationDepletionAndAmortizationPropertyPlantAndEquipment","Depreciation"],"USD")
  };
  const maps={};
  for (const [k,f] of Object.entries(concepts)) maps[k]=annualDurationMap(f, k==="eps"?"USD/shares":"USD");
  return annualEnds.map(end => {
    const revenue=valueAt(maps.revenue,end), op=valueAt(maps.operatingIncome,end), da=valueAt(maps.da,end);
    const ocf=valueAt(maps.ocf,end), capex=valueAt(maps.capex,end);
    return {
      year:Number(end.slice(0,4)), periodLabel:`FY ${end.slice(0,4)}`, periodType:"FY", periodEnd:end,
      revenue,
      grossProfit:valueAt(maps.grossProfit,end),
      ebitda:(op!=null&&da!=null)?op+da:null,
      operatingIncome:op,
      netIncome:valueAt(maps.netIncome,end),
      eps:valueAt(maps.eps,end),
      operatingCashFlow:ocf,
      capex,
      freeCashFlow:(ocf!=null&&capex!=null)?ocf-capex:null
    };
  });
}

function currentInterim(facts, latestAnnualEnd) {
  const rev = pickConcept(facts,["RevenueFromContractWithCustomerExcludingAssessedTax","Revenues","SalesRevenueNet","SalesRevenueGoodsNet","SalesRevenueServicesNet"],"USD");
  const r = latestInterimMap(rev,"USD",latestAnnualEnd);
  if (!r) return null;
  const end=r.end;
  const duration=daysBetween(r.start,r.end)||0;
  const periodType=duration>120?"YTD":"QTD";
  const get=(names,unit="USD")=>{
    const f=pickConcept(facts,names,unit); if(!f) return null;
    const rows=allUnits(f,unit).filter(x=>x&&x.end===end&&/^10-Q(?:\/A)?$/.test(x.form||""));
    if(!rows.length)return null;
    // Match revenue duration as closely as possible.
    rows.sort((a,b)=>Math.abs((daysBetween(b.start,b.end)||0)-duration)-Math.abs((daysBetween(a.start,a.end)||0)-duration));
    return itemVal(rows[0]);
  };
  const revenue=itemVal(r);
  const gross=get(["GrossProfit"]);
  const op=get(["OperatingIncomeLoss"]);
  const ni=get(["NetIncomeLoss","ProfitLoss"]);
  const eps=get(["EarningsPerShareDiluted"],"USD/shares");
  const ocf=get(["NetCashProvidedByUsedInOperatingActivities","NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"]);
  const capex=get(["PaymentsToAcquirePropertyPlantAndEquipment","PaymentsForAdditionsToPropertyPlantAndEquipment","PaymentsToAcquireProductiveAssets"]);
  const da=get(["DepreciationDepletionAndAmortization","DepreciationDepletionAndAmortizationPropertyPlantAndEquipment","Depreciation"]);
  return {year:Number(end.slice(0,4)),periodLabel:`${periodType} through ${end}`,periodType,periodEnd:end,revenue,grossProfit:gross,ebitda:(op!=null&&da!=null)?op+da:null,operatingIncome:op,netIncome:ni,eps,operatingCashFlow:ocf,capex,freeCashFlow:(ocf!=null&&capex!=null)?ocf-capex:null};
}

function latestBalanceValue(facts,names,unit="USD") {
  const f=pickConcept(facts,names,unit); return itemVal(latestInstant(f,unit));
}

function sourceUrls(cik) {
  const padded=String(cik).padStart(10,"0");
  return [
    {label:"SEC Company Facts",url:`https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`,type:"SEC"},
    {label:"SEC Submissions",url:`https://data.sec.gov/submissions/CIK${padded}.json`,type:"SEC"}
  ];
}

module.exports = async function handler(req,res) {
  try {
    const ticker=String((req.query&&req.query.ticker)||"").trim().toUpperCase();
    if(!ticker) return res.status(400).json({error:"ticker is required"});
    const map=await tickerMap();
    const meta=map[ticker];
    if(!meta) return res.status(404).json({error:`Ticker ${ticker} not found in SEC company ticker list`});
    const cik=String(meta.cik_str).padStart(10,"0");
    const [cf,sub]=await Promise.all([
      fetchJson(`${SEC_BASE}/api/xbrl/companyfacts/CIK${cik}.json`),
      fetchJson(`${SEC_BASE}/submissions/CIK${cik}.json`)
    ]);
    const facts=cf.facts||{};
    const revenueFact=pickConcept(facts,["RevenueFromContractWithCustomerExcludingAssessedTax","Revenues","SalesRevenueNet","SalesRevenueGoodsNet","SalesRevenueServicesNet"],"USD");
    const ends=fiscalYearsFromRevenue(revenueFact);
    if(!ends.length) return res.status(422).json({error:"No usable annual revenue XBRL facts were found for this issuer"});
    const historical=deriveSeries(facts,ends);
    const latestAnnualEnd=ends[ends.length-1];
    const currentPeriod=currentInterim(facts,latestAnnualEnd);

    const cash=latestBalanceValue(facts,["CashAndCashEquivalentsAtCarryingValue","CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents","CashAndDueFromBanks"]);
    const debtCurrent=latestBalanceValue(facts,["LongTermDebtCurrent","ShortTermBorrowings","ShortTermDebtCurrent"]);
    const debtNoncurrent=latestBalanceValue(facts,["LongTermDebtNoncurrent","LongTermDebtAndFinanceLeaseObligationsNoncurrent","LongTermDebt"]);
    const debt=(debtCurrent||0)+(debtNoncurrent||0) || null;
    const shares=latestBalanceValue(facts,["EntityCommonStockSharesOutstanding"],"shares") || latestBalanceValue(facts,["CommonStockSharesOutstanding"],"shares");
    const assetsCurrent=latestBalanceValue(facts,["AssetsCurrent"]);
    const liabilitiesCurrent=latestBalanceValue(facts,["LiabilitiesCurrent"]);
    const equity=latestBalanceValue(facts,["StockholdersEquity","StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]);
    const latest=historical[historical.length-1]||{};
    const ratios={
      grossMargin: latest.revenue&&latest.grossProfit!=null ? latest.grossProfit/latest.revenue*100 : null,
      operatingMargin: latest.revenue&&latest.operatingIncome!=null ? latest.operatingIncome/latest.revenue*100 : null,
      ebitdaMargin: latest.revenue&&latest.ebitda!=null ? latest.ebitda/latest.revenue*100 : null,
      netMargin: latest.revenue&&latest.netIncome!=null ? latest.netIncome/latest.revenue*100 : null,
      roe:null,roa:null,roic:null,
      currentRatio:assetsCurrent&&liabilitiesCurrent?assetsCurrent/liabilitiesCurrent:null,
      debtToEquity:debt!=null&&equity?debt/equity:null,
      interestCoverage:null
    };

    const tickRecent=(sub&&sub.filings&&sub.filings.recent)||{};
    const latestFiled=(tickRecent.filingDate&&tickRecent.filingDate[0])||null;
    res.setHeader("Cache-Control","s-maxage=21600, stale-while-revalidate=86400");
    return res.status(200).json({
      ticker,name:cf.entityName||meta.title||ticker,sector:null,industry:null,fiscalYearEnd:null,
      financialValuesScale:1,shareValuesScale:1,
      currentPrice:null,marketCap:null,enterpriseValue:null,pe:null,evEbitda:null,dividendYield:null,
      cash,debt,shares,historical,currentPeriod,ratios,
      sources:sourceUrls(cik),verifiedAsOf:new Date().toISOString().slice(0,10),latestSECFiledDate:latestFiled,
      dataMethod:"SEC Company Facts deterministic extraction"
    });
  } catch (e) {
    return res.status(500).json({error:e && e.message ? e.message : "SEC financials failed"});
  }
};
