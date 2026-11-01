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

test('diagnostics can probe the precise 90-candle scheduled request without entering paper trades',async()=>{
  const requested=[];
  const diagnostics=await binanceDiagnostics(async input=>{
    const u=new URL(input);
    requested.push(u.searchParams.get('limit'));
    if(u.hostname==='api-gcp.binance.com')return {ok:true,status:200,json:async()=>klines('BTCUSDT')};
    return {ok:false,status:451};
  },90);
  assert.equal(diagnostics.requestLimit,90);
  assert.deepEqual(requested,Array(BINANCE_API_HOSTS.length).fill('90'));
  assert.equal(diagnostics.results.find(r=>r.host==='api-gcp.binance.com').validBinanceKlines,true);
  assert.equal(diagnostics.results.filter(r=>r.validBinanceKlines).length,1);
});
