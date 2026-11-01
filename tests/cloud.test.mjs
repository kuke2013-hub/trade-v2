import test from 'node:test';
import assert from 'node:assert/strict';
import {CLOUD_PAIRS, BINANCE_API_HOSTS, marketDataClient, binanceDiagnostics, subset, tick, summary, scheduledRun} from '../cloud/worker.mjs';
import {createState} from '../engine.mjs';

const H=3600000,MIN=60000;
const START=Date.UTC(2026,9,31,12,0,20);
function klines(symbol,now=START){
  const lastOpen=Math.floor(now/H)*H-H;
  return Array.from({length:90},(_,i)=>{
    const openTime=lastOpen-(89-i)*H;
    const last=i===89;
    const breakout=symbol==='ETHUSDT'&&last;
    const open=breakout?101:100,high=breakout?104:101,low=breakout?100.9:99,close=breakout?103.5:100;
    return [openTime,String(open),String(high),String(low),String(close),'100',openTime+H-1];
  });
}
function fixture(now=START,{bitcoinFailure=false}={}){
  const called=[];
  const fetcher=async(input)=>{
    const url=new URL(input),path=url.pathname,params=url.searchParams;
    called.push(url.toString());
    if(url.host.includes('github.io'))return {ok:false,status:404};
    if(bitcoinFailure && params.get('symbol')==='BTCUSDT')return {ok:false,status:503};
    if(path.endsWith('/klines')&&params.get('interval')==='1h')return {ok:true,json:async()=>klines(params.get('symbol'),now)};
    if(path.endsWith('/klines')&&params.get('interval')==='1m')return {ok:true,json:async()=>[]};
    if(path.endsWith('/bookTicker'))return {ok:true,json:async()=>({askPrice:'104.5',bidPrice:'104.4'})};
    throw Error('Unexpected request '+url.toString());
  };
  return {fetcher,called};
}
function blank(){return {paper:createState(),meta:{lastRun:null,lastSuccess:null,lastError:null,lastBatch:[],markPrices:{}}};}
function fakeDB(){
 let rev=0,stored=null;
 return {get state(){return stored?JSON.parse(stored):null;},
   exec:async sql=>{assert.match(sql,/CREATE TABLE IF NOT EXISTS/);},
   prepare(sql){let values=[];return {
     bind(...args){values=args;return this;},
     async run(){
       if(sql.startsWith('INSERT')){if(stored===null){stored=values[0];return {meta:{changes:1}};}return {meta:{changes:0}};}
       if(sql.startsWith('UPDATE')){if(values[2]!==rev)return {meta:{changes:0}};stored=values[0];rev++;return {meta:{changes:1}};}
       throw Error('Unknown sql: '+sql);
     },
     async first(){if(sql.startsWith('SELECT'))return {revision:rev,payload:stored};throw Error('Unknown first sql');}
   };}
 };
}
test('cloud universe is bounded, distinct, and excludes delisted legacy pairs',()=>{
 assert.equal(new Set(CLOUD_PAIRS).size,CLOUD_PAIRS.length);
 assert.ok(CLOUD_PAIRS.length<30);
 assert.ok(!CLOUD_PAIRS.includes('LUNAUSDT'));
 assert.equal(CLOUD_PAIRS.flatMap((_,i)=>[i]).length,CLOUD_PAIRS.length);
 let seen=[];for(let i=0;i<5;i++)seen.push(...subset(START+i*3*MIN).symbols);
 assert.deepEqual(new Set(seen),new Set(CLOUD_PAIRS));
});
test('cloud tick uses authentic-hourly signal and opens eligible rules independently; no synthetic ML entry',async()=>{
 const {fetcher,called}=fixture();const state=await tick(blank(),START,fetcher);
 assert.equal(state.meta.lastScanCount,4);
 assert.equal(state.paper.portfolios.breakout.positions.length,1);
 assert.equal(state.paper.portfolios.ml.positions.length,0);
 assert.equal(state.paper.portfolios.breakout.positions[0].symbol,'ETHUSDT');
 assert.ok(called.some(s=>s.includes('symbol=BTCUSDT')));
 assert.equal(summary(state).performance.openCount,2);
 assert.equal(summary(state).performance.realised,0);
 assert.equal(summary(state).performance.estimatedNet!==null,true);
});
test('cloud repeated same signal creates no duplicates and respects separate portfolios',async()=>{
 const {fetcher}=fixture();let state=await tick(blank(),START,fetcher);
 state=await tick(state,START,fetcher);
 assert.equal(state.paper.portfolios.breakout.positions.length,1);
 assert.equal(state.paper.portfolios.ml.positions.length,0);
});
test('cloud fails closed without benchmark and keeps no invented trades',async()=>{
 const {fetcher}=fixture(START,{bitcoinFailure:true});
 await assert.rejects(()=>tick(blank(),START,fetcher),/Cannot safely evaluate market signals/);
});
test('D1 compare-and-swap persistent run produces distinct browser-independent state',async()=>{
 const DB=fakeDB();const {fetcher}=fixture();const first=await scheduledRun({DB},START,fetcher);
 assert.equal(first.performance.openCount,2);
 const second=await scheduledRun({DB},START,fetcher);
 assert.equal(second.performance.openCount,2);
 assert.ok(DB.state.meta.lastSuccess);
 assert.equal(DB.state.paper.portfolios.breakout.positions.length,1);
});
test('read-only Worker endpoints do not permit creating positions',async()=>{
 const {default:worker}=await import('../cloud/worker.mjs');
 const resp=await worker.fetch(new Request('https://worker.test/api/status',{method:'POST'}),{DB:fakeDB()});
 assert.equal(resp.status,405);
});


test('official Binance fallback survives a 403 on GCP and reuses the healthy host',async()=>{
  const calls=[];
  const fetcher=async input=>{
    const u=new URL(input);calls.push(u.host);
    if(u.host==='api-gcp.binance.com')return {ok:false,status:403};
    if(u.host==='data-api.binance.vision')return {ok:true,status:200,json:async()=>[{close:'100'}]};
    throw Error('Should not try a denied third host');
  };
  const market=marketDataClient(fetcher);
  assert.deepEqual(await market.get('klines?symbol=BTCUSDT&interval=1h&limit=1'),[{close:'100'}]);
  assert.equal(market.lastHost,'data-api.binance.vision');
  await market.get('ticker/bookTicker?symbol=ETHUSDT');
  assert.deepEqual(calls,['api-gcp.binance.com','data-api.binance.vision','data-api.binance.vision']);
});

test('Cloudflare diagnostic healthy GCP endpoint is chosen before an unrelated host 451',async()=>{
  const calls=[];
  const market=marketDataClient(async input=>{
    const host=new URL(input).host;calls.push(host);
    if(host==='api-gcp.binance.com')return {ok:true,status:200,json:async()=>[{close:'101'}]};
    throw Error('No second endpoint should be consulted');
  });
  assert.deepEqual(await market.get('klines?symbol=BTCUSDT'),[{close:'101'}]);
  assert.equal(market.lastHost,'api-gcp.binance.com');
  assert.deepEqual(calls,['api-gcp.binance.com']);
});

test('HTTP 451 on preferred host fails closed without checking alternative endpoints',async()=>{
  const calls=[];
  const market=marketDataClient(async input=>{calls.push(new URL(input).host);return {ok:false,status:451};});
  await assert.rejects(()=>market.get('klines?symbol=BTCUSDT'),/api-gcp.binance.com:451/);
  assert.deepEqual(calls,['api-gcp.binance.com']);
});

test('Binance 429 rate ban is never bypassed by switching hosts',async()=>{
  const called=[];
  const market=marketDataClient(async input=>{
    called.push(new URL(input).host);
    return {ok:false,status:429};
  });
  await assert.rejects(()=>market.get('klines?symbol=BTCUSDT'),/429/);
  assert.deepEqual(called,['api-gcp.binance.com']);
});

test('all unavailable Binance Spot endpoints are reported precisely without paper trades',async()=>{
  const called=[];
  const fail=async input=>{called.push(new URL(input).host);return {ok:false,status:403};};
  const market=marketDataClient(fail);
  await assert.rejects(()=>market.get('klines?symbol=BTCUSDT'),error=>
    BINANCE_API_HOSTS.every(x=>error.message.includes(new URL(x).host+':403')));
  assert.equal(called.length,BINANCE_API_HOSTS.length);
  await assert.rejects(()=>tick(blank(),START,fail),/Cannot safely evaluate market signals/);
});

test('read-only diagnostic checks real kline shape per official endpoint',async()=>{
  const diagnostic=await binanceDiagnostics(async input=>{
    const host=new URL(input).host;
    if(host==='api-gcp.binance.com')return {ok:false,status:403};
    return {ok:true,status:200,json:async()=>[klines('BTCUSDT')[0],klines('BTCUSDT')[1]]};
  });
  assert.equal(diagnostic.results.length,BINANCE_API_HOSTS.length);
  assert.equal(diagnostic.results[0].httpStatus,403);
  assert.equal(diagnostic.results[0].validBinanceKlines,false);
  assert.equal(diagnostic.results[1].validBinanceKlines,true);
});

// Authenticated GitHub->D1 transport tests use real, deterministic paper-engine transitions.
test('D1 writer is sealed: missing secret, invalid secret and unauthenticated writes fail',async()=>{
  const {default:worker}=await import('../cloud/worker.mjs');
  const DB=fakeDB(),valid='a'.repeat(64);
  const url='https://worker.test/api/state';
  assert.equal((await worker.fetch(new Request(url),{DB})).status,503);
  assert.equal((await worker.fetch(new Request(url),{DB,TRADE_V2_INGEST_TOKEN:valid})).status,401);
  assert.equal((await worker.fetch(new Request(url,{headers:{Authorization:'Bearer wrong'}}),{DB,TRADE_V2_INGEST_TOKEN:valid})).status,401);
  assert.equal((await worker.fetch(new Request('https://worker.test/api/commit',{method:'POST',body:'{}'}),{DB,TRADE_V2_INGEST_TOKEN:valid})).status,401);
  const auth=new Request(url,{headers:{Authorization:`Bearer ${valid}`}});
  const response=await worker.fetch(auth,{DB,TRADE_V2_INGEST_TOKEN:valid});
  assert.equal(response.status,200);
  const full=await response.json();assert.equal(full.revision,0);
  assert.equal(full.state.paper.portfolios.ml.positions.length,0);
  assert.equal(typeof worker.scheduled,'undefined','Cloudflare Cron handler must be removed');
});

test('authenticated D1 commit requires a real full-market scan and rejects stale revisions or resetting balances',async()=>{
  const {default:worker,CLOUD_PAIRS}=await import('../cloud/worker.mjs');
  const DB=fakeDB(),secret='b'.repeat(64),env={DB,TRADE_V2_INGEST_TOKEN:secret};
  const headers={Authorization:`Bearer ${secret}`,'Content-Type':'application/json'};
  const read=await (await worker.fetch(new Request('https://worker.test/api/state',{headers}),env)).json();
  const {fetcher}=fixture();
  const after=await tick(read.state,START,fetcher,{allPairs:true,marketHosts:['https://data-api.binance.vision']});
  assert.equal(after.meta.lastScanCount,CLOUD_PAIRS.length);
  assert.equal(after.meta.marketDataHost,'data-api.binance.vision');
  assert.equal(after.meta.collector,'github-actions');
  const url='https://worker.test/api/commit';
  const body={baseRevision:read.revision,runId:'123456-1',state:after};
  const post=async payload=>worker.fetch(new Request(url,{method:'POST',headers,body:JSON.stringify(payload)}),env);
  const accepted=await post(body);
  assert.equal(accepted.status,200);
  assert.equal((await accepted.json()).revision,1);
  assert.equal(DB.state.paper.portfolios.breakout.positions.length,1);
  const second=await post(body);
  assert.equal(second.status,200,'replay of the same run must be idempotent');
  const emptyReset=structuredClone(after);
  emptyReset.paper.portfolios.breakout.positions=[];
  emptyReset.meta.lastRun=new Date(START+300000).toISOString();emptyReset.meta.lastSuccess=emptyReset.meta.lastRun;
  assert.equal((await post({baseRevision:1,runId:'123457-1',state:emptyReset})).status,422);
  assert.equal((await post({baseRevision:0,runId:'123458-1',state:after})).status,409);
  assert.equal(DB.state.paper.portfolios.breakout.positions.length,1,'rejected state must never overwrite D1');
});

test('GitHub collector retrieves authenticated state, computes real fixture signals, and commits once',async()=>{
  const {default:worker}=await import('../cloud/worker.mjs');
  const {collectOnce}=await import('../cloud/collector.mjs');
  const secret='c'.repeat(64),DB=fakeDB(),{fetcher:markets,called}=fixture();
  const transport=async(url,options={})=>{
    if(new URL(url).host==='trade-v2-monitor.kuletski2013.workers.dev'){
      return worker.fetch(new Request(url,options),{DB,TRADE_V2_INGEST_TOKEN:secret});
    }
    return markets(url,options);
  };
  const result=await collectOnce({token:secret,runId:'87654321-1',now:START,fetcher:transport});
  assert.equal(result.scanned,CLOUD_PAIRS.length);
  assert.equal(result.marketDataHost,'data-api.binance.vision');
  assert.equal(result.revision,1);
  assert.equal(DB.state.paper.portfolios.breakout.positions.length,1);
  assert.equal(DB.state.meta.lastGitHubRunId,'87654321-1');
  assert.equal(called.filter(s=>s.includes('/klines?')).length,18);
  assert.ok(called.filter(s=>s.includes('/api/v3/')).every(s=>s.startsWith('https://data-api.binance.vision/')));
  const repeated=await collectOnce({token:secret,runId:'87654321-1',now:START,fetcher:transport});
  assert.equal(repeated.duplicate,true);
  assert.equal(repeated.revision,1);
});

test('failed Binance feed cannot write a GitHub collector trade state',async()=>{
  const {default:worker}=await import('../cloud/worker.mjs');
  const {collectOnce}=await import('../cloud/collector.mjs');
  const secret='d'.repeat(64),DB=fakeDB();
  const fetcher=async(url,init={})=>new URL(url).host.endsWith('.workers.dev')
    ?worker.fetch(new Request(url,init),{DB,TRADE_V2_INGEST_TOKEN:secret})
    :{ok:false,status:451};
  await assert.rejects(()=>collectOnce({token:secret,runId:'87654321-1',now:START,fetcher}),/Cannot safely evaluate market signals/);
  assert.equal(DB.state?.paper.portfolios.breakout.positions.length,0);
  assert.equal(DB.state?.meta.lastSuccess,null);
});


test('90-candle diagnostics verify the exact scheduled market-request shape',async()=>{
  const responses=await binanceDiagnostics(async input=>({ok:true,status:200,json:async()=>klines('BTCUSDT')}),90);
  assert.equal(responses.requestLimit,90);
  assert.equal(responses.results.length,BINANCE_API_HOSTS.length);
  assert.equal(responses.results.every(x=>x.validBinanceKlines),true);
});

test('stale benchmark candles fail closed without paper signals',async()=>{
  const {fetcher}=fixture(START);
  await assert.rejects(()=>tick(blank(),START+4*H,fetcher,{allPairs:true,marketHosts:['https://data-api.binance.vision']}),/BTC hourly feed is stale/);
});