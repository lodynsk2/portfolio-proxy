// Vercel Serverless Function: /api/sec-financials?ticker=MSFT
// Source of truth: SEC EDGAR Company Facts + Submissions APIs.
// Set SEC_CONTACT in Vercel env to a real contact string.

const SEC_BASE = "https://data.sec.gov";
const SEC_WWW = "https://www.sec.gov";
const UA = process.env.SEC_CONTACT || "PortfolioManager financial-dashboard contact@example.com";
const DAY = 24 * 60 * 60 * 1000;
const ANNUAL_FORMS = new Set(["10-K","10-K/A","20-F","20-F/A","40-F","40-F/A"]);
const INTERIM_FORMS = new Set(["10-Q","10-Q/A","6-K","6-K/A"]);
const FILED_FORMS = new Set([...ANNUAL_FORMS, ...INTERIM_FORMS]);
let tickerCache = null;
let tickerCacheAt = 0;

function headers(){
  return {"User-Agent":UA,"Accept-Encoding":"gzip, deflate","Accept":"application/json"};
}
async function fetchJson(url){
  const r = await fetch(url,{headers:headers()});
  if(!r.ok) throw new Error(`SEC request failed ${r.status}: ${url}`);
  return r.json();
}
async function tickerMap(){
  if(tickerCache && Date.now()-tickerCacheAt<DAY) return tickerCache;
  const raw = await fetchJson(`${SEC_WWW}/files/company_tickers.json`);
  const map={};
  Object.values(raw||{}).forEach(x=>{if(x&&x.ticker) map[String(x.ticker).toUpperCase()]=x;});
  tickerCache=map; tickerCacheAt=Date.now(); return map;
}
function daysBetween(a,b){if(!a||!b)return null;return Math.round((new Date(b)-new Date(a))/86400000);}
function allUnits(fact,unit){
  if(!fact||!fact.units)return [];
  if(unit&&fact.units[unit])return fact.units[unit];
  const keys=Object.keys(fact.units); return keys.length?fact.units[keys[0]]:[];
}
function unitKeys(fact){return fact&&fact.units?Object.keys(fact.units):[];}
function isMoneyUnit(u){return !!u && u!=="shares" && u!=="pure" && !String(u).includes("/shares");}
function chooseMoneyUnit(fact,preferred){
  const keys=unitKeys(fact).filter(isMoneyUnit);
  if(preferred&&keys.includes(preferred))return preferred;
  if(keys.includes("USD"))return "USD";
  return keys[0]||null;
}
function choosePerShareUnit(fact,currency){
  const keys=unitKeys(fact);
  if(currency&&keys.includes(currency+"/shares"))return currency+"/shares";
  return keys.find(k=>String(k).endsWith("/shares"))||null;
}
function latestFiledWins(rows){
  const out=new Map();
  for(const x of rows){
    if(!x||!x.end)continue;
    const prev=out.get(x.end);
    if(!prev || String(x.filed||"")>String(prev.filed||"")) out.set(x.end,x);
  }
  return out;
}
function annualRows(fact,unit){
  const rows=allUnits(fact,unit).filter(x=>{
    if(!x||!x.start||!x.end||!ANNUAL_FORMS.has(x.form||""))return false;
    const d=daysBetween(x.start,x.end); return d!=null&&d>=250&&d<=450;
  });
  return [...latestFiledWins(rows).values()].sort((a,b)=>String(a.end).localeCompare(String(b.end)));
}
function interimRows(fact,unit,afterEnd){
  return allUnits(fact,unit).filter(x=>{
    if(!x||!x.start||!x.end||!INTERIM_FORMS.has(x.form||""))return false;
    if(afterEnd&&x.end<=afterEnd)return false;
    const d=daysBetween(x.start,x.end); return d!=null&&d>=60&&d<=300;
  });
}
function latestInstant(fact,unit){
  const rows=allUnits(fact,unit).filter(x=>x&&x.end&&FILED_FORMS.has(x.form||""));
  rows.sort((a,b)=>String(a.end).localeCompare(String(b.end))||String(a.filed||"").localeCompare(String(b.filed||"")));
  return rows.length?rows[rows.length-1]:null;
}
function latestDuration(fact,unit){
  const rows=allUnits(fact,unit).filter(x=>{
    if(!x||!x.start||!x.end||!FILED_FORMS.has(x.form||""))return false;
    const d=daysBetween(x.start,x.end); return d!=null&&d>=60&&d<=450;
  });
  rows.sort((a,b)=>String(a.end).localeCompare(String(b.end))||String(a.filed||"").localeCompare(String(b.filed||"")));
  return rows.length?rows[rows.length-1]:null;
}
function itemVal(x){return x&&Number.isFinite(Number(x.val))?Number(x.val):null;}
function valueAt(map,end){const x=map&&map.get(end);return itemVal(x);}

function candidateFacts(facts,names){
  const out=[];
  for(const taxonomy of ["us-gaap","ifrs-full","dei"]){
    const tax=(facts&&facts[taxonomy])||{};
    for(const name of names){if(tax[name])out.push({taxonomy,name,fact:tax[name]});}
  }
  return out;
}
function bestAnnualFact(facts,names,type="money",preferredCurrency=null){
  let best=null;
  for(const c of candidateFacts(facts,names)){
    let unit=type==="shares"?"shares":type==="eps"?choosePerShareUnit(c.fact,preferredCurrency):chooseMoneyUnit(c.fact,preferredCurrency);
    if(!unit)continue;
    const rows=annualRows(c.fact,unit);
    if(!rows.length)continue;
    const latest=rows[rows.length-1].end||"";
    const score=rows.length*100000000 + Number(String(latest).replace(/-/g,""));
    if(!best||score>best.score)best={...c,unit,rows,score};
  }
  return best;
}
function bestFactForUnit(facts,names,unit){
  let best=null;
  for(const c of candidateFacts(facts,names)){
    if(!unitKeys(c.fact).includes(unit))continue;
    const rows=annualRows(c.fact,unit);
    const latest=rows.length?(rows[rows.length-1].end||""):"";
    const score=rows.length*100000000+Number(String(latest).replace(/-/g,""));
    if(!best||score>best.score)best={...c,unit,rows,score};
  }
  return best;
}
function annualMap(best){return best?new Map(best.rows.map(x=>[x.end,x])):new Map();}

function classifyProfile(sub){
  const sic=Number(sub&&sub.sic)||0;
  const desc=String((sub&&sub.sicDescription)||"").toLowerCase();
  if(sic===6798||desc.includes("real estate investment trust")||desc.includes("reit")) return "reit";
  if(sic>=6000&&sic<=6799) return "financial";
  return "standard";
}
function sourceUrls(cik){
  const padded=String(cik).padStart(10,"0");
  return [
    {label:"SEC Company Facts",url:`https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`,type:"SEC"},
    {label:"SEC Submissions",url:`https://data.sec.gov/submissions/CIK${padded}.json`,type:"SEC"}
  ];
}
function countValues(periods){
  const keys=["revenue","grossProfit","ebitda","operatingIncome","netIncome","eps","operatingCashFlow","capex","freeCashFlow"];
  return (periods||[]).reduce((n,p)=>n+keys.reduce((m,k)=>m+(p&&p[k]!=null?1:0),0),0);
}

function buildDataset(facts,sub,listedTickers){
  const revenueNames=["RevenueFromContractWithCustomerExcludingAssessedTax","Revenues","SalesRevenueNet","SalesRevenueGoodsNet","SalesRevenueServicesNet","Revenue"];
  const revenueBest=bestAnnualFact(facts,revenueNames,"money",null);
  if(!revenueBest)throw new Error("No usable annual revenue facts were found for this issuer");
  const currency=revenueBest.unit;
  const annualBase=revenueBest.rows.slice(-5);
  const annualEnds=annualBase.map(x=>x.end);
  const latestAnnualEnd=annualEnds[annualEnds.length-1];

  const concepts={
    grossProfit:bestFactForUnit(facts,["GrossProfit"],currency),
    operatingIncome:bestFactForUnit(facts,["OperatingIncomeLoss","ProfitLossFromOperatingActivities"],currency),
    netIncome:bestFactForUnit(facts,["NetIncomeLoss","ProfitLoss","NetIncomeLossAvailableToCommonStockholdersBasic"],currency),
    ocf:bestFactForUnit(facts,["NetCashProvidedByUsedInOperatingActivities","NetCashProvidedByUsedInOperatingActivitiesContinuingOperations","CashFlowsFromUsedInOperatingActivities"],currency),
    capex:bestFactForUnit(facts,["PaymentsToAcquirePropertyPlantAndEquipment","PaymentsForAdditionsToPropertyPlantAndEquipment","PaymentsToAcquireProductiveAssets","PurchaseOfPropertyPlantAndEquipment"],currency),
    da:bestFactForUnit(facts,["DepreciationDepletionAndAmortization","DepreciationDepletionAndAmortizationPropertyPlantAndEquipment","Depreciation","DepreciationAndAmortisationExpense"],currency),
    assets:bestFactForUnit(facts,["Assets"],currency),
    equity:bestFactForUnit(facts,["StockholdersEquity","StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest","Equity"],currency),
    interest:bestFactForUnit(facts,["InterestExpenseNonOperating","InterestExpense","FinanceCosts"],currency)
  };
  const epsBest=bestAnnualFact(facts,["EarningsPerShareDiluted","DilutedEarningsLossPerShare"],"eps",currency);
  const dilutedSharesBest=bestAnnualFact(facts,["WeightedAverageNumberOfDilutedSharesOutstanding","WeightedAverageNumberOfSharesOutstandingDiluted"],"shares");
  const maps={revenue:annualMap(revenueBest)};
  Object.keys(concepts).forEach(k=>maps[k]=annualMap(concepts[k]));
  maps.eps=annualMap(epsBest); maps.dilutedShares=annualMap(dilutedSharesBest);

  const historical=annualBase.map(base=>{
    const end=base.end;
    const fy=base.fy!=null?Number(base.fy):Number(end.slice(0,4));
    const revenue=valueAt(maps.revenue,end),op=valueAt(maps.operatingIncome,end),da=valueAt(maps.da,end);
    const ocf=valueAt(maps.ocf,end),capexRaw=valueAt(maps.capex,end),capex=capexRaw==null?null:Math.abs(capexRaw);
    return {
      year:fy, fiscalYear:fy, fiscalPeriod:base.fp||"FY", periodLabel:`FY ${fy}`, periodType:"FY", periodEnd:end, form:base.form||null, filed:base.filed||null,
      revenue,grossProfit:valueAt(maps.grossProfit,end),ebitda:(op!=null&&da!=null)?op+da:null,operatingIncome:op,netIncome:valueAt(maps.netIncome,end),eps:valueAt(maps.eps,end),
      dilutedWeightedShares:valueAt(maps.dilutedShares,end),operatingCashFlow:ocf,capex,freeCashFlow:(ocf!=null&&capex!=null)?ocf-capex:null,
      assets:valueAt(maps.assets,end),equity:valueAt(maps.equity,end),interestExpense:valueAt(maps.interest,end)
    };
  });

  // Latest interim period based on revenue; 10-Q for domestic issuers and 6-K where structured foreign-issuer interim facts exist.
  const revInterim=interimRows(revenueBest.fact,currency,latestAnnualEnd);
  let currentPeriod=null;
  if(revInterim.length){
    const maxEnd=revInterim.map(x=>x.end).sort().slice(-1)[0];
    const same=revInterim.filter(x=>x.end===maxEnd).sort((a,b)=>(daysBetween(a.start,a.end)||0)-(daysBetween(b.start,b.end)||0)||String(a.filed||"").localeCompare(String(b.filed||"")));
    const r=same[same.length-1]; const duration=daysBetween(r.start,r.end)||0;
    const periodType=duration>120?"YTD":"QTD";
    const fy=r.fy!=null?Number(r.fy):Number(r.end.slice(0,4)); const fp=r.fp?String(r.fp).toUpperCase():null;
    const get=(names,type="money")=>{
      let bf=type==="eps"?bestAnnualFact(facts,names,"eps",currency):type==="shares"?bestAnnualFact(facts,names,"shares"):bestFactForUnit(facts,names,currency);
      if(!bf)return null; const unit=type==="eps"?choosePerShareUnit(bf.fact,currency):type==="shares"?"shares":currency;
      const rows=allUnits(bf.fact,unit).filter(x=>x&&x.end===r.end&&INTERIM_FORMS.has(x.form||""));
      if(!rows.length)return null;
      rows.sort((a,b)=>Math.abs((daysBetween(a.start,a.end)||0)-duration)-Math.abs((daysBetween(b.start,b.end)||0)-duration)||String(b.filed||"").localeCompare(String(a.filed||"")));
      return itemVal(rows[0]);
    };
    const revenue=itemVal(r),gross=get(["GrossProfit"]),op=get(["OperatingIncomeLoss","ProfitLossFromOperatingActivities"]),ni=get(["NetIncomeLoss","ProfitLoss","NetIncomeLossAvailableToCommonStockholdersBasic"]),eps=get(["EarningsPerShareDiluted","DilutedEarningsLossPerShare"],"eps"),ocf=get(["NetCashProvidedByUsedInOperatingActivities","NetCashProvidedByUsedInOperatingActivitiesContinuingOperations","CashFlowsFromUsedInOperatingActivities"]),capexRaw=get(["PaymentsToAcquirePropertyPlantAndEquipment","PaymentsForAdditionsToPropertyPlantAndEquipment","PaymentsToAcquireProductiveAssets","PurchaseOfPropertyPlantAndEquipment"]),capex=capexRaw==null?null:Math.abs(capexRaw),da=get(["DepreciationDepletionAndAmortization","DepreciationDepletionAndAmortizationPropertyPlantAndEquipment","Depreciation","DepreciationAndAmortisationExpense"]);
    let label=`${periodType} through ${r.end}`; if(fp&&/^Q[1-4]$/.test(fp))label=`${fp} FY${fy}${periodType==="YTD"&&fp!=="Q1"?" YTD":""}`;
    currentPeriod={year:fy,fiscalYear:fy,fiscalPeriod:fp,periodLabel:label,periodType,periodEnd:r.end,form:r.form||null,filed:r.filed||null,revenue,grossProfit:gross,ebitda:(op!=null&&da!=null)?op+da:null,operatingIncome:op,netIncome:ni,eps,operatingCashFlow:ocf,capex,freeCashFlow:(ocf!=null&&capex!=null)?ocf-capex:null};
  }

  function latestBalance(names){
    let best=null;
    for(const c of candidateFacts(facts,names)){
      const unit=chooseMoneyUnit(c.fact,currency); if(unit!==currency)continue;
      const x=latestInstant(c.fact,unit); if(x&&(!best||String(x.end)>String(best.end)||String(x.filed||"")>String(best.filed||"")))best=x;
    }
    return itemVal(best);
  }
  const cash=latestBalance(["CashAndCashEquivalentsAtCarryingValue","CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents","CashAndDueFromBanks","CashAndCashEquivalents"]);
  const marketableSecurities=latestBalance(["MarketableSecuritiesCurrent","ShortTermInvestments"]);
  const liquidAssets=(cash!=null||marketableSecurities!=null)?Number(cash||0)+Number(marketableSecurities||0):null;
  const debtCurrent=latestBalance(["LongTermDebtCurrent","ShortTermBorrowings","ShortTermDebtCurrent","CurrentBorrowings"]);
  let debtNoncurrent=latestBalance(["LongTermDebtNoncurrent","LongTermDebtAndFinanceLeaseObligationsNoncurrent","NoncurrentBorrowings"]);
  if(debtNoncurrent==null)debtNoncurrent=latestBalance(["LongTermDebt"]);
  const debt=(debtCurrent!=null||debtNoncurrent!=null)?Number(debtCurrent||0)+Number(debtNoncurrent||0):null;

  // Shares outstanding. For multi-ticker CIKs (e.g. GOOG/GOOGL, BRK.A/BRK.B), a single-class price times aggregate shares is unsafe.
  let shares=null,sharesAsOf=null,sharesBasis=null,sharesApproximate=false;
  for(const c of candidateFacts(facts,["EntityCommonStockSharesOutstanding","CommonStockSharesOutstanding"])){
    if(!unitKeys(c.fact).includes("shares"))continue;
    const x=latestInstant(c.fact,"shares");
    if(x&&(!sharesAsOf||String(x.end)>=String(sharesAsOf))){shares=itemVal(x);sharesAsOf=x.end;sharesBasis="SEC shares outstanding";}
  }
  if(shares==null){
    const ds=bestAnnualFact(facts,["WeightedAverageNumberOfDilutedSharesOutstanding","WeightedAverageNumberOfSharesOutstandingDiluted"],"shares");
    const x=ds?latestDuration(ds.fact,"shares"):null; shares=itemVal(x); sharesAsOf=x&&x.end||null; sharesBasis=shares!=null?"SEC diluted weighted-average shares (fallback)":null; sharesApproximate=shares!=null;
  }

  const profile=classifyProfile(sub);
  const latest=historical[historical.length-1]||{},prior=historical.length>1?historical[historical.length-2]:null;
  const avg=(a,b)=>(a!=null&&b!=null)?(Number(a)+Number(b))/2:null;
  const avgEquity=prior?avg(prior.equity,latest.equity):null,avgAssets=prior?avg(prior.assets,latest.assets):null;
  const ratios={
    grossMargin:latest.revenue&&latest.grossProfit!=null?latest.grossProfit/latest.revenue*100:null,
    operatingMargin:latest.revenue&&latest.operatingIncome!=null?latest.operatingIncome/latest.revenue*100:null,
    ebitdaMargin:profile==="financial"?null:(latest.revenue&&latest.ebitda!=null?latest.ebitda/latest.revenue*100:null),
    netMargin:latest.revenue&&latest.netIncome!=null?latest.netIncome/latest.revenue*100:null,
    roe:avgEquity&&latest.netIncome!=null?latest.netIncome/avgEquity*100:null,
    roa:avgAssets&&latest.netIncome!=null?latest.netIncome/avgAssets*100:null,
    roic:null,
    currentRatio:profile==="financial"?null:null,
    debtToEquity:debt!=null&&latest.equity?debt/latest.equity:null,
    interestCoverage:profile==="financial"?null:(latest.interestExpense&&latest.operatingIncome!=null?latest.operatingIncome/Math.abs(latest.interestExpense):null)
  };
  // Current ratio from latest instant values only for non-financials.
  if(profile!=="financial"){
    const ac=latestBalance(["AssetsCurrent","CurrentAssets"]),lc=latestBalance(["LiabilitiesCurrent","CurrentLiabilities"]);
    ratios.currentRatio=ac&&lc?ac/lc:null;
  }

  const warnings=[]; const checks=[];
  checks.push({name:"Annual periods",status:historical.length>=3?"PASS":"WARN",detail:`${historical.length} completed annual periods`});
  if(historical.length<5)warnings.push("Fewer than five completed annual periods were available in structured SEC facts.");
  for(const p of historical){
    if(p.freeCashFlow!=null&&p.operatingCashFlow!=null&&p.capex!=null){
      const diff=Math.abs(p.freeCashFlow-(p.operatingCashFlow-p.capex)); const tol=Math.max(1,Math.abs(p.freeCashFlow)*1e-9);
      if(diff>tol)warnings.push(`${p.periodLabel}: free cash flow failed OCF − CapEx check.`);
    }
  }
  checks.push({name:"FCF formula",status:warnings.some(w=>w.includes("free cash flow"))?"WARN":"PASS",detail:"FCF is derived only as operating cash flow minus CapEx"});
  if(currentPeriod&&currentPeriod.periodEnd<=latestAnnualEnd)warnings.push("Interim period was not newer than the latest annual period and should be reviewed.");
  if(profile==="financial")warnings.push("Financial-institution profile: EBITDA, EV/EBITDA, current ratio, and interest coverage are intentionally withheld when not decision-useful.");
  const multipleShareClasses=(listedTickers||[]).length>1;
  if(multipleShareClasses)warnings.push(`Multiple listed tickers share this CIK (${listedTickers.join(", ")}); price × aggregate shares is disabled for market-cap fallback.`);
  if(currency!=="USD")warnings.push(`Statements are reported in ${currency}. DCF-to-U.S.-listed-share comparisons require FX/ADR conversion and should be disabled unless explicitly converted.`);
  if(sharesApproximate)warnings.push("Only diluted weighted-average shares were available; this is not treated as a precise market-cap share count.");
  const checkedValues=countValues(historical)+(currentPeriod?countValues([currentPeriod]):0)+(cash!=null?1:0)+(debt!=null?1:0)+(shares!=null?1:0);

  return {
    historical,currentPeriod,currency,profile,ratios,cash,marketableSecurities,liquidAssets,debt,shares,sharesAsOf,sharesBasis,sharesApproximate,multipleShareClasses,listedTickers,
    marketCapDerivationAllowed:currency==="USD"&&!multipleShareClasses&&!sharesApproximate&&shares!=null,
    evMetricsMeaningful:profile!=="financial",
    dcfComparableToQuote:currency==="USD"&&!multipleShareClasses,
    validation:{status:warnings.length?"WARN":"PASS",warnings,checks,checkedValues},
    metricNotes:profile==="financial"?"Financial-institution profile: prioritize P/E, P/B, ROE/ROA and capital metrics over EV/EBITDA.":profile==="reit"?"REIT profile: generic EBITDA/DCF should be supplemented with FFO/AFFO.":"Standard corporate profile"
  };
}

export default async function handler(req,res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  res.setHeader("Cache-Control","s-maxage=21600, stale-while-revalidate=86400");
  if(req.method==="OPTIONS")return res.status(204).end();
  try{
    let ticker=String((req.query&&req.query.ticker)||"").trim().toUpperCase();
    if(!ticker)return res.status(400).json({error:"ticker is required"});
    const requestedTicker=ticker;
    const map=await tickerMap();
    let meta=map[ticker];
    if(!meta&&ticker.includes(".")){ticker=ticker.replace(/\./g,"-");meta=map[ticker];}
    if(!meta&&ticker.includes("-")){const dotted=ticker.replace(/-/g,".");if(map[dotted]){ticker=dotted;meta=map[ticker];}}
    if(!meta)return res.status(404).json({error:`Ticker ${requestedTicker} not found in SEC company ticker list`});
    const cik=String(meta.cik_str).padStart(10,"0");
    const listedTickers=Object.values(map).filter(x=>String(x.cik_str)===String(meta.cik_str)).map(x=>String(x.ticker).toUpperCase()).sort();
    const [cf,sub]=await Promise.all([fetchJson(`${SEC_BASE}/api/xbrl/companyfacts/CIK${cik}.json`),fetchJson(`${SEC_BASE}/submissions/CIK${cik}.json`)]);
    const facts=cf.facts||{}; const dataset=buildDataset(facts,sub,listedTickers);
    const recent=(sub&&sub.filings&&sub.filings.recent)||{}; const latestFiled=(recent.filingDate&&recent.filingDate[0])||null;
    return res.status(200).json({
      ticker,requestedTicker,name:cf.entityName||meta.title||ticker,sector:null,industry:sub&&sub.sicDescription||null,sic:sub&&sub.sic||null,fiscalYearEnd:sub&&sub.fiscalYearEnd||null,
      financialValuesScale:1,shareValuesScale:1,currentPrice:null,marketCap:null,enterpriseValue:null,pe:null,evEbitda:null,dividendYield:null,
      ...dataset,sources:sourceUrls(cik),verifiedAsOf:new Date().toISOString().slice(0,10),latestSECFiledDate:latestFiled,
      dataMethod:"SEC Company Facts deterministic extraction (10-K/10-Q/20-F/40-F/6-K aware)",
      accuracyNote:"Filed statement values come from SEC XBRL. Unavailable or structurally ambiguous metrics are left blank. Market-cap fallback is disabled for multi-class issuers and approximate share counts."
    });
  }catch(e){return res.status(500).json({error:e&&e.message?e.message:"SEC financials failed"});}
}
