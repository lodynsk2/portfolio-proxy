// Vercel Serverless Function: /api/macro-calendar?year=2026&month=8
// US macro calendar with official schedules + actual/previous values from FRED
// and optional consensus forecasts from Trading Economics.
// Required: FRED_API_KEY
// Optional: TRADING_ECONOMICS_API_KEY

const FRED_BASE = "https://api.stlouisfed.org/fred";
const FRED_API_KEY = process.env.FRED_API_KEY || process.env.FRED_KEY || process.env.FRED_APIKEY || "";
const TE_API_KEY = process.env.TRADING_ECONOMICS_API_KEY || process.env.TE_API_KEY || "";
const CACHE_MS = 6 * 60 * 60 * 1000;
const releaseCache = new Map();
const seriesCache = new Map();
const teCache = new Map();

const RELEASES = [
  { id:10, label:"Consumer Price Index", short:"CPI / Core CPI", time:"8:30 AM", category:"Inflation", impact:"High", source:"BLS", officialUrl:"https://www.bls.gov/cpi/", fredSeries:"CPIAUCSL", fredTransform:"pct", decimals:1, suffix:"%", metricLabel:"Headline CPI MoM", tePatterns:["inflation rate mom","cpi mom"] },
  { id:46, label:"Producer Price Index", short:"PPI", time:"8:30 AM", category:"Inflation", impact:"Medium", source:"BLS", officialUrl:"https://www.bls.gov/ppi/", fredSeries:"PPIFIS", fredTransform:"pct", decimals:1, suffix:"%", metricLabel:"PPI Final Demand MoM", tePatterns:["ppi mom","producer price index mom","producer prices mom"] },
  { id:50, label:"Employment Situation", short:"Nonfarm Payrolls", time:"8:30 AM", category:"Labor", impact:"High", source:"BLS", officialUrl:"https://www.bls.gov/news.release/empsit.toc.htm", fredSeries:"PAYEMS", fredTransform:"diff", decimals:0, suffix:"K", metricLabel:"Payroll Change", tePatterns:["non farm payrolls","nonfarm payrolls"] },
  { id:192, label:"Job Openings and Labor Turnover Survey", short:"JOLTS Job Openings", time:"10:00 AM", category:"Labor", impact:"Medium", source:"BLS", officialUrl:"https://www.bls.gov/jlt/", fredSeries:"JTSJOL", fredTransform:"levelThousands", decimals:2, suffix:"M", metricLabel:"Job Openings", tePatterns:["jolts job openings","job openings"] },
  { id:180, label:"Unemployment Insurance Weekly Claims Report", short:"Initial Jobless Claims", time:"8:30 AM", category:"Labor", impact:"Low", source:"DOL", officialUrl:"https://www.dol.gov/ui/data.pdf", fredSeries:"ICSA", fredTransform:"claims", decimals:0, suffix:"K", metricLabel:"Initial Claims", tePatterns:["initial jobless claims"] },
  { id:9, label:"Advance Monthly Sales for Retail and Food Services", short:"Retail Sales", time:"8:30 AM", category:"Growth", impact:"Medium", source:"Census", officialUrl:"https://www.census.gov/retail/index.html", fredSeries:"RSAFS", fredTransform:"pct", decimals:1, suffix:"%", metricLabel:"Retail Sales MoM", tePatterns:["retail sales mom","retail sales"] },
  { id:53, label:"Gross Domestic Product", short:"GDP", time:"8:30 AM", category:"Growth", impact:"High", source:"BEA", officialUrl:"https://www.bea.gov/data/gdp/gross-domestic-product", fredSeries:"A191RL1Q225SBEA", fredTransform:"direct", decimals:1, suffix:"%", metricLabel:"Real GDP QoQ Annualized", tePatterns:["gdp growth rate qoq","gdp growth rate"] },
  { id:54, label:"Personal Income and Outlays", short:"PCE / Core PCE", time:"8:30 AM", category:"Inflation", impact:"High", source:"BEA", officialUrl:"https://www.bea.gov/data/income-saving/personal-income", fredSeries:"PCEPILFE", fredTransform:"pct", decimals:1, suffix:"%", metricLabel:"Core PCE MoM", tePatterns:["core pce price index mom","core pce price index"] },
  { id:26, label:"Manufacturing ISM Report on Business", short:"ISM Manufacturing", time:"10:00 AM", category:"Survey", impact:"Medium", source:"ISM", officialUrl:"https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/", fredSeries:null, fredTransform:null, decimals:1, suffix:"", metricLabel:"ISM Manufacturing PMI", tePatterns:["ism manufacturing pmi"] },
  { id:13, label:"G.17 Industrial Production and Capacity Utilization", short:"Industrial Production", time:"9:15 AM", category:"Growth", impact:"Medium", source:"Federal Reserve", officialUrl:"https://www.federalreserve.gov/releases/g17/", fredSeries:"INDPRO", fredTransform:"pct", decimals:1, suffix:"%", metricLabel:"Industrial Production MoM", tePatterns:["industrial production mom","industrial production"] }
];

const FOMC_DATES = {
  2025:["2025-01-29","2025-03-19","2025-05-07","2025-06-18","2025-07-30","2025-09-17","2025-10-29","2025-12-10"],
  2026:["2026-01-28","2026-03-18","2026-04-29","2026-06-17","2026-07-29","2026-09-16","2026-10-28","2026-12-09"],
  2027:["2027-01-27","2027-03-17","2027-04-28","2027-06-09","2027-07-28","2027-09-15","2027-10-27","2027-12-08"]
};

function cors(res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  res.setHeader("Cache-Control","s-maxage=21600, stale-while-revalidate=86400");
}
function pad(n){return String(n).padStart(2,"0");}
function isoDate(d){return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;}
function addDays(dateStr,days){const d=new Date(dateStr+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+days);return isoDate(d);}
function monthBounds(year,month){const start=`${year}-${pad(month)}-01`;const end=isoDate(new Date(Date.UTC(year,month,0)));return {start,end};}
function isInMonth(date,year,month){return typeof date==="string"&&date.startsWith(`${year}-${pad(month)}-`);}
function impactRank(x){return x==="High"?0:x==="Medium"?1:2;}

function parseNumber(value){
  if(value==null||value==="")return null;
  if(typeof value==="number")return Number.isFinite(value)?value:null;
  let s=String(value).trim().replace(/,/g,"");
  if(!s)return null;
  let mult=1; const last=s.slice(-1).toUpperCase();
  if(last==="K"){mult=1e3;s=s.slice(0,-1);} else if(last==="M"){mult=1e6;s=s.slice(0,-1);} else if(last==="B"){mult=1e9;s=s.slice(0,-1);} else if(last==="T"){mult=1e12;s=s.slice(0,-1);}
  s=s.replace(/[%$]/g,""); const n=Number(s); return Number.isFinite(n)?n*mult:null;
}
function surprisePct(actual,forecast){const a=parseNumber(actual),f=parseNumber(forecast);if(a==null||f==null||f===0)return null;return Number((((a-f)/Math.abs(f))*100).toFixed(1));}
function formatValue(value,cfg){
  if(value==null||!Number.isFinite(Number(value)))return null;
  const n=Number(value),dec=Number.isFinite(cfg.decimals)?cfg.decimals:1,suffix=cfg.suffix||"";
  if(suffix==="M")return (n/1000).toFixed(dec)+"M";
  return n.toFixed(dec)+suffix;
}

async function fredJson(path,params){
  if(!FRED_API_KEY)throw new Error("Missing FRED_API_KEY in Vercel environment variables");
  const qs=new URLSearchParams({...params,api_key:FRED_API_KEY,file_type:"json"});
  const r=await fetch(`${FRED_BASE}/${path}?${qs.toString()}`); const body=await r.json().catch(()=>({}));
  if(!r.ok||body.error_code)throw new Error(body.error_message||`FRED ${path} HTTP ${r.status}`);
  return body;
}
async function fetchReleaseDates(releaseId){
  const c=releaseCache.get(releaseId); if(c&&Date.now()-c.at<CACHE_MS)return c.dates;
  const body=await fredJson("release/dates",{release_id:String(releaseId),include_release_dates_with_no_data:"true",limit:"10000",sort_order:"desc"});
  const dates=Array.isArray(body.release_dates)?body.release_dates.map(x=>x&&x.date).filter(Boolean):[];
  releaseCache.set(releaseId,{at:Date.now(),dates}); return dates;
}
async function fetchSeriesObservations(seriesId,start,end){
  const key=`${seriesId}|${start}|${end}`; const c=seriesCache.get(key); if(c&&Date.now()-c.at<CACHE_MS)return c.rows;
  const body=await fredJson("series/observations",{series_id:seriesId,observation_start:start,observation_end:end,sort_order:"asc"});
  const rows=Array.isArray(body.observations)?body.observations.map(x=>({date:x.date,value:x.value==="."?null:Number(x.value)})).filter(x=>x.date&&x.value!=null&&Number.isFinite(x.value)):[];
  seriesCache.set(key,{at:Date.now(),rows}); return rows;
}
function deriveFredSeriesValues(rows,releaseDate,cfg,isFuture){
  if(!Array.isArray(rows)||!rows.length||!cfg||!cfg.fredTransform)return {actual:null,previous:null};
  const eligible=rows.filter(x=>x.date<=releaseDate); if(!eligible.length)return {actual:null,previous:null};
  function val(i){
    if(i<0||i>=eligible.length)return null; const cur=eligible[i];
    if(cfg.fredTransform==="direct")return cur.value;
    if(cfg.fredTransform==="claims")return cur.value/1000;
    if(cfg.fredTransform==="levelThousands")return cur.value;
    if(cfg.fredTransform==="diff")return i<1?null:cur.value-eligible[i-1].value;
    if(cfg.fredTransform==="pct")return i<1||eligible[i-1].value===0?null:(cur.value/eligible[i-1].value-1)*100;
    return null;
  }
  const i=eligible.length-1;
  return isFuture?{actual:null,previous:val(i)}:{actual:val(i),previous:val(i-1)};
}

function teDateOnly(v){return String(v||"").slice(0,10);}
function normalizeText(s){return String(s||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
function teEventScore(row,cfg){
  const text=normalizeText(`${row.Event||""} ${row.Category||""}`); let best=0;
  for(const p of cfg.tePatterns||[]){const pat=normalizeText(p);if(!pat)continue;if(text===pat)best=Math.max(best,100);else if(text.includes(pat))best=Math.max(best,80);else{const words=pat.split(" ");best=Math.max(best,words.filter(w=>text.includes(w)).length*10);}}
  return best;
}
async function fetchTradingEconomics(start,end){
  if(!TE_API_KEY)return [];
  const key=`${start}|${end}`; const c=teCache.get(key); if(c&&Date.now()-c.at<CACHE_MS)return c.rows;
  const url=`https://api.tradingeconomics.com/calendar/country/united%20states/${start}/${end}?c=${encodeURIComponent(TE_API_KEY)}&values=true&f=json`;
  const r=await fetch(url); const body=await r.json().catch(()=>[]);
  if(!r.ok||!Array.isArray(body))throw new Error(body&&body.Message?body.Message:`Trading Economics HTTP ${r.status}`);
  teCache.set(key,{at:Date.now(),rows:body}); return body;
}
function selectTeEvent(rows,date,cfg){
  const xs=rows.filter(x=>teDateOnly(x.Date)===date).map(x=>({row:x,score:teEventScore(x,cfg)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  return xs.length?xs[0].row:null;
}
function previousTeEvent(rows,current,cfg){
  if(!current)return null; const date=teDateOnly(current.Date);
  const xs=rows.filter(x=>teDateOnly(x.Date)<date).map(x=>({row:x,score:teEventScore(x,cfg)})).filter(x=>x.score>0).sort((a,b)=>{const ad=teDateOnly(a.row.Date),bd=teDateOnly(b.row.Date);return ad!==bd?bd.localeCompare(ad):b.score-a.score;});
  return xs.length?xs[0].row:null;
}
function applyTeValues(event,cfg,rows){
  const current=selectTeEvent(rows,event.date,cfg); if(!current)return event; const prev=previousTeEvent(rows,current,cfg);
  const actual=current.Actual!==""&&current.Actual!=null?current.Actual:event.actual;
  const forecast=current.Forecast!==""&&current.Forecast!=null?current.Forecast:null;
  const previous=current.Previous!==""&&current.Previous!=null?current.Previous:event.previous;
  const prevForecast=prev&&prev.Forecast!==""&&prev.Forecast!=null?prev.Forecast:null;
  const prevActual=prev&&prev.Actual!==""&&prev.Actual!=null?prev.Actual:null;
  return {...event,actual,forecast,previous,surprisePct:surprisePct(actual,forecast),previousSurprisePct:surprisePct(prevActual,prevForecast),consensusSource:"Trading Economics",consensusUrl:current.URL?"https://tradingeconomics.com"+current.URL:"https://tradingeconomics.com/united-states/calendar",teEvent:current.Event||current.Category||null};
}

async function enrichFredValues(events,year,month,warnings){
  const byRelease={}; RELEASES.forEach(c=>{byRelease[c.id]=c;});
  const seriesIds=[...new Set(RELEASES.map(x=>x.fredSeries).filter(Boolean))];
  const {start,end}=monthBounds(year,month),obsStart=addDays(start,-120),obsEnd=addDays(end,10);
  const settled=await Promise.allSettled(seriesIds.map(async id=>({id,rows:await fetchSeriesObservations(id,obsStart,obsEnd)})));
  const bySeries={}; settled.forEach((r,i)=>{const id=seriesIds[i];if(r.status==="fulfilled")bySeries[id]=r.value.rows;else warnings.push(`${id}: ${r.reason&&r.reason.message?r.reason.message:"FRED observations unavailable"}`);});
  const today=new Date().toISOString().slice(0,10);
  return events.map(event=>{
    const cfg=event.releaseId!=null?byRelease[event.releaseId]:null; if(!cfg||!cfg.fredSeries)return event;
    const vals=deriveFredSeriesValues(bySeries[cfg.fredSeries]||[],event.date,cfg,event.date>today);
    return {...event,metricLabel:cfg.metricLabel||null,actual:vals.actual==null?null:formatValue(vals.actual,cfg),previous:vals.previous==null?null:formatValue(vals.previous,cfg),valueSource:"FRED / official source"};
  });
}

export default async function handler(req,res){
  cors(res); if(req.method==="OPTIONS")return res.status(204).end(); if(req.method!=="GET")return res.status(405).json({error:"GET only"});
  try{
    const now=new Date(),year=Number((req.query&&req.query.year)||now.getFullYear()),month=Number((req.query&&req.query.month)||(now.getMonth()+1));
    if(!Number.isInteger(year)||year<2000||year>2100||!Number.isInteger(month)||month<1||month>12)return res.status(400).json({error:"Use year=YYYY and month=1..12"});

    const settled=await Promise.allSettled(RELEASES.map(async cfg=>({cfg,dates:await fetchReleaseDates(cfg.id)})));
    let events=[]; const warnings=[];
    settled.forEach((r,i)=>{const cfg=RELEASES[i];if(r.status!=="fulfilled"){warnings.push(`${cfg.short}: ${r.reason&&r.reason.message?r.reason.message:"release dates unavailable"}`);return;}r.value.dates.filter(d=>isInMonth(d,year,month)).forEach(date=>events.push({id:`fred-${cfg.id}-${date}`,date,time:cfg.time,timezone:"ET",title:cfg.short,fullTitle:cfg.label,metricLabel:cfg.metricLabel||null,category:cfg.category,impact:cfg.impact,source:cfg.source,sourceType:"FRED release calendar",sourceUrl:cfg.officialUrl,fredUrl:`https://fred.stlouisfed.org/release?rid=${cfg.id}`,releaseId:cfg.id,actual:null,forecast:null,previous:null,surprisePct:null,previousSurprisePct:null}));});

    (FOMC_DATES[year]||[]).filter(d=>isInMonth(d,year,month)).forEach(date=>events.push({id:`fomc-${date}`,date,time:"2:00 PM",timezone:"ET",title:"FOMC Rate Decision",fullTitle:"Federal Open Market Committee Policy Decision",metricLabel:"Federal Funds Target Range",category:"Fed",impact:"High",source:"Federal Reserve",sourceType:"Official FOMC meeting calendar",sourceUrl:"https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",actual:null,forecast:null,previous:null,surprisePct:null,previousSurprisePct:null}));

    events=await enrichFredValues(events,year,month,warnings);

    let teRows=[];
    if(TE_API_KEY){
      const {start,end}=monthBounds(year,month);
      try{teRows=await fetchTradingEconomics(addDays(start,-100),end);}catch(e){warnings.push("Trading Economics: "+(e&&e.message?e.message:"consensus unavailable"));}
    }
    if(teRows.length){const byRelease={};RELEASES.forEach(c=>{byRelease[c.id]=c;});events=events.map(e=>e.releaseId!=null&&byRelease[e.releaseId]?applyTeValues(e,byRelease[e.releaseId],teRows):e);}

    events.sort((a,b)=>a.date.localeCompare(b.date)||impactRank(a.impact)-impactRank(b.impact)||a.time.localeCompare(b.time));
    return res.status(200).json({year,month,timezone:"America/New_York",events,warnings,sourceSummary:TE_API_KEY?"FRED official schedule + FRED actuals + Trading Economics consensus":"FRED official schedule + FRED actual/previous values",consensusEnabled:Boolean(TE_API_KEY),consensusProvider:TE_API_KEY?"Trading Economics":null,consensusNote:TE_API_KEY?"Forecasts are survey consensus values from Trading Economics.":"Forecast and surprise require TRADING_ECONOMICS_API_KEY. Actual and previous values still use FRED.",updatedAt:new Date().toISOString()});
  }catch(e){return res.status(500).json({error:e&&e.message?e.message:"Macro calendar failed"});}
