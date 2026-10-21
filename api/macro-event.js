import { upstreamFetch, upstreamJson, finite, fredRows, noStoreErrors } from "../lib/upstream.js";

// Vercel Serverless Function: /api/macro-event?releaseId=180&date=2026-08-06
// Loads ONE event's values on demand, so the monthly calendar stays fast.
// Actual/Previous: FRED/ALFRED. Optional consensus: Trading Economics.
// Required: FRED_API_KEY
// Optional: TRADING_ECONOMICS_API_KEY

const FRED_BASE = "https://api.stlouisfed.org/fred";
const FRED_API_KEY =( process.env.FRED_API_KEY || process.env.FRED_KEY || process.env.FRED_APIKEY || "").trim();
const TE_API_KEY =( process.env.TRADING_ECONOMICS_API_KEY || process.env.TE_API_KEY || "").trim();

const CONFIG = {
  10:  { series:"CPIAUCSL", transform:"pct", decimals:1, suffix:"%", te:["inflation rate mom","cpi mom"] },
  46:  { series:"PPIFIS", transform:"pct", decimals:1, suffix:"%", te:["ppi mom","producer price index mom","producer prices mom"] },
  50:  { series:"PAYEMS", transform:"diff", decimals:0, suffix:"K", te:["non farm payrolls","nonfarm payrolls"] },
  192: { series:"JTSJOL", transform:"millions", decimals:2, suffix:"M", te:["jolts job openings","job openings"] },
  180: { series:"ICSA", transform:"claims", decimals:0, suffix:"K", te:["initial jobless claims"] },
  9:   { series:"RSAFS", transform:"pct", decimals:1, suffix:"%", te:["retail sales mom","retail sales"] },
  53:  { series:"A191RL1Q225SBEA", transform:"direct", decimals:1, suffix:"%", te:["gdp growth rate qoq","gdp growth rate"] },
  54:  { series:"PCEPILFE", transform:"pct", decimals:1, suffix:"%", te:["core pce price index mom","core pce price index"] },
  26:  { series:null, transform:null, decimals:1, suffix:"", te:["ism manufacturing pmi"] },
  13:  { series:"INDPRO", transform:"pct", decimals:1, suffix:"%", te:["industrial production mom","industrial production"] }
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
}

function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s||"")) && Number.isFinite(Date.parse(s+"T00:00:00Z")) && iso(new Date(s+"T00:00:00Z"))===s; }
function iso(d) { return d.toISOString().slice(0,10); }
function addDays(s,n) { const d=new Date(s+"T12:00:00Z"); d.setUTCDate(d.getUTCDate()+n); return iso(d); }

async function fredObservations(series, releaseDate, historical) {
  if (!FRED_API_KEY) throw new Error("Missing FRED_API_KEY in Vercel environment variables");

  const realtime = historical ? releaseDate : new Date().toISOString().slice(0,10);
  const qs = new URLSearchParams({
    series_id: series,
    api_key: FRED_API_KEY,
    file_type: "json",
    observation_start: addDays(releaseDate,-150),
    observation_end: releaseDate,
    realtime_start: realtime,
    realtime_end: realtime,
    sort_order: "asc"
  });

  const body = await upstreamJson(`${FRED_BASE}/series/observations?${qs.toString()}`, {}, "FRED/ALFRED");
  return fredRows(body,series).sort((a,b)=>a.date.localeCompare(b.date));
}

function transformed(rows, cfg, idx) {
  if (!rows || idx<0 || idx>=rows.length) return null;
  const cur=rows[idx];
  if (cfg.transform==="direct") return cur.value;
  if (cfg.transform==="claims") return cur.value/1000;
  if (cfg.transform==="millions") return cur.value/1000;
  if (cfg.transform==="diff") return idx>0 ? cur.value-rows[idx-1].value : null;
  if (cfg.transform==="pct") return idx>0 && rows[idx-1].value!==0 ? (cur.value/rows[idx-1].value-1)*100 : null;
  return null;
}

function format(v,cfg) {
  if (v==null || !Number.isFinite(Number(v))) return null;
  return Number(v).toFixed(cfg.decimals)+cfg.suffix;
}

function parseNum(v) {
  if (v==null || v==="") return null;
  if (typeof v==="number") return Number.isFinite(v)?v:null;
  let s=String(v).trim().replace(/,/g,"");
  let mult=1; const last=s.slice(-1).toUpperCase();
  if(last==="K"){mult=1e3;s=s.slice(0,-1);} else if(last==="M"){mult=1e6;s=s.slice(0,-1);} else if(last==="B"){mult=1e9;s=s.slice(0,-1);}
  s=s.replace(/[%$]/g,""); const n=Number(s); return Number.isFinite(n)?n*mult:null;
}
function surprisePct(a,f){const x=parseNum(a),y=parseNum(f); if(x==null||y==null||y===0)return null; return Number((((x-y)/Math.abs(y))*100).toFixed(1));}
function norm(s){return String(s||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
function score(row,cfg){const text=norm(`${row.Event||""} ${row.Category||""}`);let best=0;for(const p of cfg.te||[]){const q=norm(p);if(text===q)best=Math.max(best,100);else if(text.includes(q))best=Math.max(best,80);else best=Math.max(best,q.split(" ").filter(w=>text.includes(w)).length*10);}return best;}

async function tradingEconomics(date,cfg) {
  if (!TE_API_KEY) return null;
  const start=addDays(date,-100), end=addDays(date,1);
  const url=`https://api.tradingeconomics.com/calendar/country/united%20states/${start}/${end}?c=${encodeURIComponent(TE_API_KEY)}&values=true&f=json`;
  const body=await upstreamJson(url,{},"Trading Economics");
  if(!Array.isArray(body)) throw new Error("Trading Economics returned an invalid calendar");

  const same=body.filter(x=>String(x.Date||"").slice(0,10)===date).map(x=>({row:x,s:score(x,cfg)})).filter(x=>x.s>0).sort((a,b)=>b.s-a.s);
  const current=same.length?same[0].row:null;
  if(!current)return null;

  const prev=body.filter(x=>String(x.Date||"").slice(0,10)<date).map(x=>({row:x,s:score(x,cfg)})).filter(x=>x.s>0).sort((a,b)=>String(b.row.Date||"").localeCompare(String(a.row.Date||""))||b.s-a.s)[0];
  const actual=current.Actual!==""&&current.Actual!=null?current.Actual:null;
  const forecast=current.Forecast!==""&&current.Forecast!=null?current.Forecast:null;
  const previous=current.Previous!==""&&current.Previous!=null?current.Previous:null;
  const pa=prev&&prev.row.Actual!==""?prev.row.Actual:null, pf=prev&&prev.row.Forecast!==""?prev.row.Forecast:null;
  return {actual,forecast,previous,surprisePct:surprisePct(actual,forecast),previousSurprisePct:surprisePct(pa,pf),consensusSource:"Trading Economics"};
}

export default async function handler(req,res) {
  noStoreErrors(res);
  cors(res);
  if(req.method==="OPTIONS")return res.status(204).end();
  if(req.method!=="GET")return res.status(405).json({error:"GET only"});

  try{
    const releaseId=Number(req.query&&req.query.releaseId);
    const date=String((req.query&&req.query.date)||"");
    const cfg=CONFIG[releaseId];
    if(!cfg||!validDate(date))return res.status(400).json({error:"Use a supported releaseId and date=YYYY-MM-DD"});

    const historical=date < new Date().toISOString().slice(0,10);
    let actual=null,previous=null,valueWarning=null;

    if(cfg.series){
      try{
        const rows=await fredObservations(cfg.series,date,historical);
        const i=rows.length-1;
        if(date <= new Date().toISOString().slice(0,10)){ actual=format(transformed(rows,cfg,i),cfg); previous=format(transformed(rows,cfg,i-1),cfg); }
        else { previous=format(transformed(rows,cfg,i),cfg); }
      }catch(e){ valueWarning=e&&e.message?e.message:"FRED values unavailable"; }
    }

    let forecast=null,surprise=null,previousSurprise=null,consensusSource=null;
    if(TE_API_KEY){
      try{
        const te=await tradingEconomics(date,cfg);
        if(te){
          // Official FRED/ALFRED values remain the primary actual/previous source.
          // Trading Economics is used for consensus fields, and only fills an
          // actual/previous value when no official FRED series is configured.
          if(!cfg.series && te.actual!=null) actual=te.actual;
          if(!cfg.series && te.previous!=null) previous=te.previous;
          forecast=te.forecast;
          surprise=forecast!=null && actual!=null ? surprisePct(actual,forecast) : null;
          previousSurprise=te.previousSurprisePct;
          consensusSource=te.consensusSource;
        }
      }catch(e){ valueWarning=[valueWarning,e&&e.message].filter(Boolean).join(" · "); }
    }

    if(valueWarning)res.setHeader("Cache-Control","no-store");
    return res.status(200).json({
      releaseId,date,actual,forecast,previous,
      surprisePct:surprise,
      previousSurprisePct:previousSurprise,
      valueSource: cfg.series ? (actual!=null || previous!=null ? "FRED/ALFRED vintage" : null) : (actual!=null ? "Trading Economics" : null),
      consensusSource,
      consensusEnabled:Boolean(TE_API_KEY),
      surpriseMethod:"Relative difference: (actual - consensus) / abs(consensus). This is a dashboard convention, not an official agency statistic.",
      warning:valueWarning||null
    });
  }catch(e){return res.status(500).json({error:e&&e.message?e.message:"Macro event lookup failed"});}
}
