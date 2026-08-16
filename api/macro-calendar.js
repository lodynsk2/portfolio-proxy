// Vercel Serverless Function: /api/macro-event?releaseId=180&date=2026-08-06
// Loads ONE event's values on demand, so the monthly calendar stays fast.
// Actual/Previous: FRED/ALFRED. Optional consensus: Trading Economics.
// Required: FRED_API_KEY
// Optional: TRADING_ECONOMICS_API_KEY

const FRED_BASE = "https://api.stlouisfed.org/fred";
const FRED_API_KEY = process.env.FRED_API_KEY || process.env.FRED_KEY || process.env.FRED_APIKEY || "";
const TE_API_KEY = process.env.TRADING_ECONOMICS_API_KEY || process.env.TE_API_KEY || "";

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

function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s||"")); }
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

  const r = await fetch(`${FRED_BASE}/series/observations?${qs.toString()}`);
  const body = await r.json().catch(()=>({}));
  if (!r.ok || body.error_code) throw new Error(body.error_message || `FRED observations HTTP ${r.status}`);

  return (Array.isArray(body.observations)?body.observations:[])
    .map(x=>({date:x.date,value:x.value==="."?null:Number(x.value)}))
    .filter(x=>x.date&&Number.isFinite(x.value));
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
  const r=await fetch(url); const body=await r.json().catch(()=>[]);
  if(!r.ok||!Array.isArray(body)) throw new Error((body&&body.Message)||`Trading Economics HTTP ${r.status}`);

  const same=body.filter(x=>String(x.Date||"").slice(0,10)===date).map(x=>({row:x,s:score(x,cfg)})).filter(x=>x.s>0).sort((a,b)=>b.s-a.s);
  const current=same.length?same[0].row:null;
  if(!current)return null;

  const prev=body.filter(x=>String(x.Date||"").slice(0,10)<date).map(x=>({row:x,s:score(x,cfg)})).filter(x=>x.s>0).sort((a,b)=>String(b.row.Date||"").localeCompare(String(a.row.Date||""))||b.s-a.s)[0];
  const actual=current.Actual!==""&&current.Actual!=null?current.Actual:null;
  // Trading Economics distinguishes survey consensus (Forecast) from its own
  // model projection (TEForecast). Prefer consensus; use the model value only
  // as an explicitly labelled fallback so the UI does not imply it is a poll.
  const hasConsensus=current.Forecast!==""&&current.Forecast!=null;
  const hasModelForecast=current.TEForecast!==""&&current.TEForecast!=null;
  const forecast=hasConsensus?current.Forecast:(hasModelForecast?current.TEForecast:null);
  const previous=current.Previous!==""&&current.Previous!=null?current.Previous:null;
  const pa=prev&&prev.row.Actual!==""?prev.row.Actual:null;
  const pf=prev&&prev.row.Forecast!==""&&prev.row.Forecast!=null
    ?prev.row.Forecast
    :(prev&&prev.row.TEForecast!==""&&prev.row.TEForecast!=null?prev.row.TEForecast:null);
  return {
    actual,forecast,previous,
    surprisePct:surprisePct(actual,forecast),
    previousSurprisePct:surprisePct(pa,pf),
    consensusSource:hasConsensus?"Trading Economics survey consensus":(hasModelForecast?"Trading Economics model forecast":null),
    forecastType:hasConsensus?"consensus":(hasModelForecast?"model":null)
  };
}

export default async function handler(req,res) {
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
        if(historical){ actual=format(transformed(rows,cfg,i),cfg); previous=format(transformed(rows,cfg,i-1),cfg); }
        else { previous=format(transformed(rows,cfg,i),cfg); }
      }catch(e){ valueWarning=e&&e.message?e.message:"FRED values unavailable"; }
    }

    let forecast=null,surprise=null,previousSurprise=null,consensusSource=null,forecastType=null;
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
          forecastType=te.forecastType;
        }
      }catch(e){ valueWarning=[valueWarning,e&&e.message].filter(Boolean).join(" · "); }
    }

    return res.status(200).json({
      releaseId,date,actual,forecast,previous,
      surprisePct:surprise,
      previousSurprisePct:previousSurprise,
      valueSource: cfg.series ? "FRED/ALFRED vintage" : (actual!=null ? "Trading Economics" : null),
      consensusSource,
      forecastType,
      consensusEnabled:Boolean(TE_API_KEY),
      surpriseMethod:"Relative difference: (actual - forecast) / abs(forecast). The forecast is survey consensus when available, otherwise an explicitly labelled model forecast. This is a dashboard convention, not an official agency statistic.",
      warning:valueWarning||(!TE_API_KEY?"Forecasts require TRADING_ECONOMICS_API_KEY in the Vercel project environment variables.":null)
    });
  }catch(e){return res.status(500).json({error:e&&e.message?e.message:"Macro event lookup failed"});}
}
