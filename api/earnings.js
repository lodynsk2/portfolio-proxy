// Vercel Serverless Function: /api/earnings?ticker=NVDA
// Requires ANTHROPIC_API_KEY (or CLAUDE_API_KEY) in Vercel environment variables.
// Purpose: source-checked quarterly EPS actual-vs-consensus + next earnings date.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const API_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "";
const MODELS = [process.env.ANTHROPIC_MODEL || "claude-sonnet-5", "claude-sonnet-4-6"];

function cors(res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  res.setHeader("Cache-Control","s-maxage=21600, stale-while-revalidate=86400");
}
function extractText(msg){
  return ((msg&&msg.content)||[]).filter(b=>b&&b.type==="text"&&b.text).map(b=>b.text).join("\n");
}
function parseJson(text){
  const clean=String(text||"").replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();
  try{return JSON.parse(clean);}catch(e){}
  let depth=0,start=-1,last=null;
  for(let i=0;i<clean.length;i++){
    if(clean[i]==="{"){if(depth===0)start=i;depth++;}
    else if(clean[i]==="}"){depth--;if(depth===0&&start>=0){try{last=JSON.parse(clean.slice(start,i+1));}catch(e){}start=-1;}}
  }
  return last;
}
async function claudeRequest(prompt,maxTokens=2200){
  if(!API_KEY)throw new Error("Missing ANTHROPIC_API_KEY in Vercel environment variables");
  let lastErr=null;
  for(const model of [...new Set(MODELS)]){
    const r=await fetch(ANTHROPIC_URL,{
      method:"POST",
      headers:{"content-type":"application/json","x-api-key":API_KEY,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({
        model,max_tokens:maxTokens,
        tools:[{type:"web_search_20250305",name:"web_search",max_uses:5}],
        messages:[{role:"user",content:prompt}]
      })
    });
    const body=await r.json().catch(()=>({}));
    if(r.ok)return {body,model};
    const msg=(body&&body.error&&body.error.message)||`Anthropic HTTP ${r.status}`;
    lastErr=new Error(`${model}: ${msg}`);
    // A 404 is commonly model/availability related; try the compatibility model.
    if(r.status!==404)break;
  }
  throw lastErr||new Error("Anthropic request failed");
}
function normalize(data){
  if(!data||!Array.isArray(data.quarters))throw new Error("No usable earnings data returned");
  const now=Date.now();
  const clean=data.quarters.filter(q=>q&&q.period&&q.source&&(q.actual!=null||q.estimate!=null)).map(q=>({
    period:String(q.period),date:q.date||null,
    actual:q.actual==null?null:Number(q.actual),estimate:q.estimate==null?null:Number(q.estimate),
    reported:q.reported!==false&&q.actual!=null,source:String(q.source),
    _time:q.date&&isFinite(Date.parse(q.date))?Date.parse(q.date):null
  })).filter(q=>(q.actual==null||Number.isFinite(q.actual))&&(q.estimate==null||Number.isFinite(q.estimate)));
  const reported=clean.filter(q=>q.reported&&q.actual!=null).sort((a,b)=>(a._time||0)-(b._time||0)).slice(-6);
  const upcoming=clean.filter(q=>!q.reported&&q.estimate!=null).sort((a,b)=>(a._time||9e15)-(b._time||9e15));
  const next=upcoming[0]||null;
  data.quarters=reported.concat(next?[next]:[]).map(q=>{const n={...q};delete n._time;return n;});
  if(data.nextEarningsDate&&isFinite(Date.parse(data.nextEarningsDate))&&Date.parse(data.nextEarningsDate)<now-86400000){
    data.nextEarningsDate=null;data.nextEarningsConfirmed=false;
  }
  if(next&&data.nextEstimate==null)data.nextEstimate=next.estimate;
  return data;
}

export default async function handler(req,res){
  cors(res);
  if(req.method==="OPTIONS")return res.status(204).end();
  if(req.method!=="GET")return res.status(405).json({error:"GET only"});
  try{
    const ticker=String((req.query&&req.query.ticker)||"").trim().toUpperCase();
    if(!ticker)return res.status(400).json({error:"ticker is required"});
    const today=new Date().toISOString().slice(0,10);
    const prompt=`Today is ${today}. Build a source-checked quarterly earnings dataset for ${ticker}.\n\nRULES:\n1) For a CONFIRMED future earnings date, use the issuer's official investor-relations event/earnings page. If no official date is announced, nextEarningsDate must be null and nextEarningsConfirmed false.\n2) For actual EPS versus consensus estimate, use the SAME identifiable consensus/market-data source and SAME EPS basis (GAAP or adjusted) for each pair. Prefer a source that publishes both values.\n3) Never mix GAAP actual EPS with adjusted consensus EPS.\n4) Return six most recent REPORTED quarters ordered oldest to newest, then at most one upcoming estimate as the final row.\n5) Every quarter row must have a direct source URL. If it cannot be verified, omit it. Do not guess.\n6) EPS must be split-adjusted as presented by the source.\n\nReturn ONLY JSON: {"ticker":"${ticker}","basis":"gaap or adjusted","nextEarningsDate":"YYYY-MM-DD or null","nextEarningsConfirmed":true,"nextEstimate":0.00,"dataAsOf":"${today}","quarters":[{"period":"Q1 FY27","date":"YYYY-MM-DD","actual":0.00,"estimate":0.00,"reported":true,"source":"https://..."},{"period":"Q2 FY27E","date":"YYYY-MM-DD","actual":null,"estimate":0.00,"reported":false,"source":"https://..."}],"sources":[{"label":"Official IR","url":"https://..."},{"label":"Consensus source","url":"https://..."}]}`;
    const first=await claudeRequest(prompt,2300);
    let candidate=normalize(parseJson(extractText(first.body)));
    const verifyPrompt=`Today is ${today}. Independently audit the following earnings dataset for ${ticker}. Verify the claimed official next earnings date against the issuer's investor-relations page. Verify every historical actual/estimate pair uses a single comparable EPS basis and has a source URL that supports both numbers. Remove unsupported rows rather than guessing. Keep reported quarters oldest-to-newest and upcoming last. Return ONLY the corrected JSON in the same schema. Candidate: ${JSON.stringify(candidate)}`;
    try{
      const second=await claudeRequest(verifyPrompt,2100);
      candidate=normalize(parseJson(extractText(second.body)));
      candidate.verificationStatus="SOURCE-CHECKED";
      candidate.modelsUsed=[first.model,second.model];
    }catch(e){
      candidate.verificationStatus="SINGLE-PASS";
      candidate.verificationWarning="Independent verification pass failed; only source-linked first-pass rows are shown.";
      candidate.modelsUsed=[first.model];
    }
    return res.status(200).json(candidate);
  }catch(e){
    return res.status(500).json({error:e&&e.message?e.message:"Earnings lookup failed"});
  }
}
