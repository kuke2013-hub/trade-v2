/* Cloudflare V2: unattended PAPER ONLY, read-only HTTP API. Never sends live orders.
   One scheduled job scans a rotating limited spot subset and records all trades in D1.
   Designed for Workers Free's 50-subrequest/10ms CPU constraints; benchmark real usage.
*/
import {STRATEGIES, DEFAULT_CONFIG, parseKlines, analyse, createState, openPaper, closePaper, evaluateExit, paperPerformance} from '../engine.mjs';
import {mlFeatures, probability, validateModel, modelAllowsPaper} from '../ml.mjs';

export const CLOUD_PAIRS = Object.freeze([
  'ETHUSDT','BNBUSDT','XRPUSDT','ADAUSDT','LTCUSDT','DOGEUSDT','TRXUSDT','LINKUSDT',
  'SOLUSDT','AVAXUSDT','NEARUSDT','DOTUSDT','ATOMUSDT','UNIUSDT','FILUSDT','ETCUSDT','ALGOUSDT'
]);
export const SHARDS = 5;
const PERIOD = 180000; // 3-minute CRON; full coin universe scanned roughly every 15 minutes
// Official Binance Spot endpoints only. No third-party prices, proxies or invented fills.
// Every URL below is listed in Binance's public Spot REST documentation.
export const BINANCE_API_HOSTS = Object.freeze([
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api-gcp.binance.com',
  'https://api1.binance.com'
]);
const RETRYABLE_HTTP = new Set([403, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const MODEL_URL = 'https://kuke2013-hub.github.io/trade-v2/models/latest.json';
const STARTED_CASH = 10000;
const MAX_POSITION_AGE_GAP = 950 * 60000;
const MAX_TRADES_RESPONSE = 100;

function emptyState(){return {paper:createState(),meta:{lastRun:null,lastSuccess:null,lastError:null,lastBatch:[],lastScanCount:0,missing:[],modelStatus:'unavailable',lastMarketPriceAt:null,markPrices:{}}};}
export function subset(now, pairs=CLOUD_PAIRS){const shard=Math.floor(now/PERIOD)%SHARDS;return {shard, symbols:pairs.filter((_,i)=>i%SHARDS===shard)};}
function validPrice(p){return Number.isFinite(p)&&p>0;}
/** Official-host failover within one scheduled invocation. Never retry 418/429 rate bans
    or 451 geographic restrictions; failing closed preserves paper-trading integrity. */
export function marketDataClient(fetcher=fetch, hosts=BINANCE_API_HOSTS){
  let preferred=0, lastHost=null;
  async function get(path){
    const indices=[preferred,...hosts.map((_,i)=>i).filter(i=>i!==preferred)];
    const failures=[];
    for(const i of indices){
      const host=hosts[i];
      let response;
      try{response=await fetcher(`${host}/api/v3/${path}`,{headers:{Accept:'application/json'}});}
      catch(error){failures.push(`${new URL(host).host}:network`);continue;}
      if(response.ok){
        // Malformed JSON is not interpreted as valid market data.
        const value=await response.json();
        preferred=i;lastHost=new URL(host).host;
        return value;
      }
      const status=Number(response.status);
      failures.push(`${new URL(host).host}:${status}`);
      if(!RETRYABLE_HTTP.has(status))break;
    }
    throw new Error(`Binance official market-data endpoints failed /${path.split('?')[0]} [${failures.join(', ')}]`);
  }
  return {get,get lastHost(){return lastHost;}};
}

/** Read-only, fixed-target connectivity check; never enters trades. */
export async function binanceDiagnostics(fetcher=fetch){
  const results=[];
  for(const base of BINANCE_API_HOSTS){
    const host=new URL(base).host;
    try{
      const response=await fetcher(`${base}/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2`,{headers:{Accept:'application/json'}});
      let valid=false;
      if(response.ok){try{const body=await response.json();valid=Array.isArray(body)&&body.length===2&&body.every(v=>Array.isArray(v)&&v.length>=7);}catch{valid=false;}}
      results.push({host,httpStatus:response.status,validBinanceKlines:valid});
    }catch{results.push({host,httpStatus:null,validBinanceKlines:false,error:'network request failed'});}
  }
  return {source:'Official Binance Spot market data',checkedAt:new Date().toISOString(),results};
}
async function externalModel(fetcher){try{
  const response=await fetcher(MODEL_URL,{headers:{Accept:'application/json'}});
  if(!response.ok)return null;
  const model=await response.json();return validateModel(model)?model:null;
}catch{return null;}}
function signalStrategies(analysis,model,coinBars,btcBars){
  if(!analysis)return [];
  const ids=STRATEGIES.filter(s=>s.id!=='ml'&&analysis.trigger[s.id]).map(s=>s.id);
  if(model?.holdout?.accepted && analysis.breakout){const f=mlFeatures(coinBars,btcBars);const p=f?probability(model,f):null;if(modelAllowsPaper(model,p))ids.push('ml');}
  return ids;
}
async function accountExits(state,now,getMarket){
  const positions=STRATEGIES.flatMap(s=>state.paper.portfolios[s.id].positions);
  const grouped=new Map();for(const p of positions){if(!grouped.has(p.symbol))grouped.set(p.symbol,[]);grouped.get(p.symbol).push(p);}
  const problems=[];
  for(const [symbol,positions] of grouped){
    const oldest=Math.min(...positions.map(p=>p.lastChecked));
    if(now-oldest>MAX_POSITION_AGE_GAP){positions.forEach(p=>p.dataGap=true);problems.push(`${symbol}: more than 950 minutes since last verified exit data`);continue;}
    try{
      const raw=await getMarket(`klines?symbol=${symbol}&interval=1m&startTime=${Math.max(0,oldest-60000)}&limit=1000`);
      const bars=parseKlines(raw,now);if(!bars.length){problems.push(`${symbol}: no completed 1m bars`);continue;}
      const earliest=bars[0].time;
      for(const position of positions){
        if(earliest>position.lastChecked+60000){position.dataGap=true;problems.push(`${symbol}: missing minute interval`);continue;}
        const eligible=bars.filter(c=>c.time>=Math.max(position.entryTime,position.lastChecked));
        const exit=evaluateExit(position,eligible,now,state.paper.config);
        if(exit)closePaper(state.paper,position.strategyId,symbol,exit.market,exit.reason,exit.at);
        else position.lastChecked=bars.at(-1).closeTime+1;
      }
    }catch(e){problems.push(`${symbol}: ${e.message}`);}
  }
  return problems;
}

/** Returns a new state; caller persists using revision-based compare-and-swap. */
export async function tick(state,now,fetcher=fetch){
  const {shard,symbols}=subset(now);
  const next=structuredClone(state);
  const failures=[];
  const market=marketDataClient(fetcher);
  // Existing positions must be checked even when no fresh breakout exists.
  const exitGaps=await accountExits(next,now,market.get);
  failures.push(...exitGaps);
  let btcBars=[];
  try{btcBars=parseKlines(await market.get('klines?symbol=BTCUSDT&interval=1h&limit=90'),now);if(btcBars.length<55)throw new Error('BTC hourly benchmark unavailable');}
  catch(e){throw new Error('Cannot safely evaluate market signals: '+e.message);}
  const btcRet24=(btcBars.at(-1).close/btcBars.at(-25).close-1)*100;
  const model=await externalModel(fetcher);
  const mlStatus=model?(model.holdout.accepted?'validated-paper-enabled':'holdout-rejected-disabled'):'not-published';
  let checked=0;
  for(const symbol of symbols){
    let series;
    try{series=parseKlines(await market.get(`klines?symbol=${symbol}&interval=1h&limit=90`),now);}
    catch(e){failures.push(`${symbol}: ${e.message}`);continue;}
    const analysis=analyse(series,btcRet24);
    if(!analysis){failures.push(`${symbol}: insufficient hourly history`);continue;}
    checked++;
    if(analysis.lastBarTime<now-15*60000||analysis.lastBarTime>now||!analysis.breakout)continue;
    const strategyIds=signalStrategies(analysis,model,series,btcBars);
    if(!strategyIds.length || exitGaps.length)continue; // fail closed if an existing position cannot be monitored
    try{
      const quote=await market.get(`ticker/bookTicker?symbol=${symbol}`);
      const ask=Number(quote.askPrice),bid=Number(quote.bidPrice);
      if(!validPrice(ask)||!validPrice(bid)||ask<bid)throw new Error('Invalid Binance bid-ask quote');
      for(const strategy of strategyIds)openPaper(next.paper,strategy,symbol,ask,analysis.lastBarTime,now);
    }catch(e){failures.push(`${symbol}: ${e.message}`);}
  }
  // Mark open positions only when current quotes exist; don't invent unrealised P&L.
  const openSymbols=[...new Set(STRATEGIES.flatMap(s=>next.paper.portfolios[s.id].positions.map(p=>p.symbol)))];
  const markPrices={};
  for(const symbol of openSymbols){try{const quote=await market.get(`ticker/bookTicker?symbol=${symbol}`);const bid=Number(quote.bidPrice);if(validPrice(bid))markPrices[symbol]=bid;else failures.push(`${symbol}: missing exit bid mark`);}catch(e){failures.push(`${symbol}: ${e.message}`);}}
  next.meta={...next.meta,lastRun:new Date(now).toISOString(),lastSuccess:new Date(now).toISOString(),lastError:null,lastBatch:symbols,lastShard:shard,lastScanCount:checked,missing:failures.slice(0,30),modelStatus:mlStatus,lastMarketPriceAt:new Date(now).toISOString(),marketDataHost:market.lastHost,markPrices};
  return next;
}
export function summary(state){
  const marks=state.meta.markPrices??{};
  const pnl=paperPerformance(state.paper,marks);
  const portfolios=STRATEGIES.map(strategy=>{const p=state.paper.portfolios[strategy.id];return {strategy:strategy.id,realised:p.trades.reduce((s,t)=>s+t.pnl,0),open:p.positions.length,closed:p.trades.length};});
  const positions=STRATEGIES.flatMap(strategy=>state.paper.portfolios[strategy.id].positions.map(p=>({strategy:strategy.id,symbol:p.symbol,entryPrice:p.entryPrice,entryTime:p.entryTime,cost:p.cost,stopPct:state.paper.config.stopPct,targetPct:state.paper.config.targetPct,dataGap:!!p.dataGap})));
  const trades=STRATEGIES.flatMap(strategy=>state.paper.portfolios[strategy.id].trades.map(t=>({strategy:strategy.id,symbol:t.symbol,entryTime:t.entryTime,exitTime:t.exitTime,entryPrice:t.entryPrice,exitPrice:t.exitPrice,pnl:t.pnl,reason:t.reason,signalBar:t.signalBar}))).sort((a,b)=>b.exitTime-a.exitTime).slice(0,MAX_TRADES_RESPONSE);
  return {source:'Cloudflare D1 independent V2 paper account',paperOnly:true,liveOrders:false,universe:CLOUD_PAIRS.length,rotationMinutes:15,initialVirtualCapital:STARTED_CASH*STRATEGIES.length,meta:state.meta,performance:pnl,portfolios,positions,trades};
}
async function ensureDB(env){
  if(!env.DB)throw Error('D1 database binding DB missing. Complete Cloudflare setup.');
  await env.DB.exec('CREATE TABLE IF NOT EXISTS cloud_state (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)');
  await env.DB.prepare('INSERT OR IGNORE INTO cloud_state (id,revision,payload,updated_at) VALUES (1,0,?,?)').bind(JSON.stringify(emptyState()),new Date().toISOString()).run();
}
async function readDB(env){
  await ensureDB(env);
  const row=await env.DB.prepare('SELECT revision, payload FROM cloud_state WHERE id=1').first();
  if(!row)throw Error('D1 state row missing');
  const state=JSON.parse(row.payload);
  if(!state.paper?.portfolios||!state.meta)throw Error('D1 paper state malformed');
  return {revision:row.revision,state};
}
export async function scheduledRun(env,now=Date.now(),fetcher=fetch){
  const {revision,state}=await readDB(env);
  let updated;
  try{updated=await tick(state,now,fetcher);}
  catch(e){
    // Preserve state and record error without erasing any existing positions.
    const message=String(e?.message||e).slice(0,400);
    state.meta.lastRun=new Date(now).toISOString();state.meta.lastError=message;
    const r=await env.DB.prepare('UPDATE cloud_state SET revision=revision+1,payload=?,updated_at=? WHERE id=1 AND revision=?').bind(JSON.stringify(state),new Date(now).toISOString(),revision).run();
    if(r.meta?.changes!==1)throw Error('Concurrent tick conflict: state not written');
    throw e;
  }
  const res=await env.DB.prepare('UPDATE cloud_state SET revision=revision+1,payload=?,updated_at=? WHERE id=1 AND revision=?').bind(JSON.stringify(updated),new Date(now).toISOString(),revision).run();
  if(res.meta?.changes!==1)throw Error('Concurrent tick conflict: no duplicate paper positions committed');
  return summary(updated);
}
export default {
  async scheduled(controller,env,ctx){try{const result=await scheduledRun(env,Date.now());console.log(JSON.stringify({event:'paper_tick',time:result.meta.lastRun,checked:result.meta.lastScanCount,open:result.performance.openCount,missing:result.meta.missing.length}));}
    catch(e){console.error('paper_tick_failed',String(e?.message||e));throw e;}},
  async fetch(request,env){
    const u=new URL(request.url);
    const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'https://kuke2013-hub.github.io','Vary':'Origin'};
    if(request.method!=='GET')return new Response(JSON.stringify({error:'Read-only API. No external trade or trigger endpoint.'}),{status:405,headers});
    if(u.pathname==='/api/binance-diagnostics'){
      const diagnostics=await binanceDiagnostics();
      return new Response(JSON.stringify(diagnostics),{status:200,headers:{...headers,'Cache-Control':'public, max-age=120'}});
    }
    if(u.pathname==='/api/status'){
      try{const {state}=await readDB(env);return new Response(JSON.stringify(summary(state)),{status:200,headers});}
      catch(e){return new Response(JSON.stringify({ready:false,error:String(e.message)}),{status:503,headers});}
    }
    if(u.pathname==='/health')return new Response(JSON.stringify({worker:true,paperOnly:true,dbBound:!!env.DB}),{headers});
    return new Response(JSON.stringify({error:'Not found'}),{status:404,headers});
  }
};