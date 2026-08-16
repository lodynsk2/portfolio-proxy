// /api/liquidity-history.js
// Fed + ECB + BoJ balance-sheet history converted to USD trillions with date-aligned FRED FX rates.
// Optional S&P 500 overlay from FRED SP500.
// Required env: FRED_API_KEY

const BASE="https://api.stlouisfed.org/fred";
const KEY=process.env.FRED_API_KEY||process.env.FRED_KEY||process.env.FRED_APIKEY||"";
function cors(res){res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type");res.setHeader("Cache-Control","s-maxage=43200, stale-while-revalidate=86400");}
function iso(d){return d.toISOString().slice(0,10);}
async function obs(series,start){
  const qs=new URLSearchParams({series_id:series,api_key:KEY,file_type:"json",observation_start:start,sort_order:"asc"});
  const r=await fetch(`${BASE}/series/observations?${qs.toString()}`);const b=await r.json().catch(()=>({}));
  if(!r.ok||b.error_code)throw new Error(b.error_message||`${series} HTTP ${r.status}`);
  return (b.observations||[]).map(x=>({date:x.date,value:x.value==="."?null:Number(x.value)})).filter(x=>x.date&&Number.isFinite(x.value));
}
function atOrBefore(rows,date){let best=null;for(const r of rows){if(r.date<=date)best=r;else break;}return best?best.value:null;}
function roc(series,days){if(!series||series.length<2)return null;const last=series[series.length-1];const target=new Date(last.date+"T12:00:00Z");target.setUTCDate(target.getUTCDate()-days);const old=atOrBefore(series,iso(target));return old&&old!==0?(last.value/old-1)*100:null;}
export default async function handler(req,res){
  cors(res);if(req.method==="OPTIONS")return res.status(204).end();if(req.method!=="GET")return res.status(405).json({error:"GET only"});
  try{
    if(!KEY)throw new Error("Missing FRED_API_KEY in Vercel environment variables");
    const start=new Date();start.setUTCFullYear(start.getUTCFullYear()-6);const startStr=iso(start);
    const names=["WALCL","ECBASSETSW","JPNASSETS","DEXUSEU","DEXJPUS","SP500"];
    const settled=await Promise.allSettled(names.map(n=>obs(n,startStr)));
    const data={};const warnings=[];
    settled.forEach((r,i)=>{if(r.status==="fulfilled")data[names[i]]=r.value;else warnings.push(`${names[i]}: ${r.reason&&r.reason.message?r.reason.message:"unavailable"}`);});
    if(!data.WALCL||!data.ECBASSETSW||!data.JPNASSETS||!data.DEXUSEU||!data.DEXJPUS)throw new Error("One or more required central-bank/FX series are unavailable");
    const fed=data.WALCL.map(x=>({date:x.date,value:x.value/1e6}));
    const ecb=data.ECBASSETSW.map(x=>{const fx=atOrBefore(data.DEXUSEU,x.date);return fx?{date:x.date,value:x.value*fx/1e6}:null;}).filter(Boolean);
    const boj=data.JPNASSETS.map(x=>{const fx=atOrBefore(data.DEXJPUS,x.date);return fx?{date:x.date,value:x.value/fx/10000}:null;}).filter(Boolean);
    const sp500=(data.SP500||[]).map(x=>({date:x.date,value:x.value}));
    // Total series sampled on Fed dates so the frontend has a consistent weekly spine.
    const total=fed.map(x=>{const e=atOrBefore(ecb,x.date),b=atOrBefore(boj,x.date);return e==null||b==null?null:{date:x.date,value:x.value+e+b};}).filter(Boolean);
    return res.status(200).json({
      fed,ecb,boj,sp500,total,
      roc13w:roc(total,91),roc52w:roc(total,364),
      units:"USD trillions for central-bank series; index points for S&P 500",
      methodology:"Fed WALCL + ECB ECBASSETSW converted by DEXUSEU + BoJ JPNASSETS converted by DEXJPUS. This is a central-bank balance-sheet proxy, not global M2.",
      warnings,updatedAt:new Date().toISOString()
    });
  }catch(e){return res.status(500).json({error:e&&e.message?e.message:"Liquidity history failed"});}
}
