import test from 'node:test';
import assert from 'node:assert/strict';
import {CLOUD_PAIRS, subset, tick, summary, scheduledRun} from '../cloud/worker.mjs';
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