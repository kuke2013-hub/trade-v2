import test from 'node:test';
import assert from 'node:assert/strict';
import {analyse,parseKlines,createState,openPaper,closePaper,evaluateExit,portfolioStats,paperPerformance,fillBuy,sellProceeds,ema,atr} from '../engine.mjs';
const HOUR=3600000;
function series({breakout=true,volume=200,compression=false}={}) {
  let t=Date.UTC(2026,8,1);
  const cs=Array.from({length:60},(_,i)=>{
    const c=100+(i%2===0?0.2:-0.2)+i*0.01;
    let width=compression&&i>27&&i<59?0.05:0.7;
    return {time:t+i*HOUR,closeTime:t+(i+1)*HOUR-1,open:c-0.1,close:c,high:c+width,low:c-width,volume:100};
  });
  if(breakout){cs[59]={...cs[59],open:101,high:104,low:100.9,close:103.5,volume};}
  return cs;
}
test('parseKlines excludes still-open candle, invalid and duplicate rows',()=>{
  const now=500000;
  const row=(t,ct)=>[t,'100','102','99','101','8',ct];
  assert.equal(parseKlines([row(1,100),row(1,100),row(2,600000),['bad','1','2','3','4','5',10]],now).length,1);
});
test('EMA and ATR are numerical only when sufficiently sampled',()=>{
  assert.ok(Number.isNaN(ema([1,2],4)));
  assert.ok(Number.isFinite(ema([1,2,3,4,5],3)));
  assert.ok(atr(series())>0);
});
test('breakout signal requires actual close above preceding resistance',()=>{
  assert.equal(analyse(series()).trigger.breakout,true);
  assert.equal(analyse(series({breakout:false})).trigger.breakout,false);
});
test('missing hourly bars suppress stale predictive signals',()=>{const c=series();c[40].time+=3600000;assert.equal(analyse(c),null);});
test('volume signal responds to volume ratio, never future bars',()=>{
  const a=analyse(series({volume:250}));
  assert.equal(a.trigger.volume,true);
  const b=analyse(series({volume:80}));
  assert.equal(b.trigger.volume,false);
  assert.equal(analyse(series().slice(0,-1)).trigger.breakout,false);
});
test('relative strength requires BTC outperformance and a breakout',()=>{
  const strong=analyse(series({volume:250}),-5);
  assert.equal(strong.trigger.strength,true);
  const weak=analyse(series({volume:250}),20);
  assert.equal(weak.trigger.strength,false);
});
test('compression uses preceding candles only',()=>{
  assert.equal(analyse(series({compression:true,volume:200})).trigger.compression,true);
  assert.equal(analyse(series({compression:false,volume:200})).trigger.compression,false);
});
test('paper trade charges two-sided fees/slippage and prevents duplicates',()=>{
  const s=createState();
  const t=Date.UTC(2026,8,3);
  assert.equal(openPaper(s,'breakout','FOOUSDT',100,t-1,t),true);
  assert.equal(openPaper(s,'breakout','FOOUSDT',100,t-1,t),false);
  const open=s.portfolios.breakout.positions[0];
  assert.ok(open.quantity>0);
  const result=closePaper(s,'breakout','FOOUSDT',102,'target',t+HOUR);
  assert.ok(result.pnl>0&&result.pnl<4);
  assert.ok(result.entryFee>0&&result.exitFee>0);
  assert.equal(s.portfolios.breakout.positions.length,0);
  assert.ok(portfolioStats(s.portfolios.breakout,{},s.config).realised===result.pnl);
});
test('stop wins ties inside OHLC candle (no lookahead profit bias)',()=>{
  const state=createState();
  const now=Date.UTC(2026,8,4);
  openPaper(state,'breakout','FOOUSDT',100,now-1,now);
  const p=state.portfolios.breakout.positions[0];
  const c={time:now+60000,closeTime:now+119999,open:100,high:104,low:97,close:101};
  assert.equal(evaluateExit(p,[c],now+120000,state.config).reason,'stop');
});
test('target, timeout and empty data handled explicitly',()=>{
  const s=createState(),t=Date.UTC(2026,8,4);
  openPaper(s,'volume','BARUSDT',100,t-1,t);
  const p=s.portfolios.volume.positions[0];
  assert.equal(evaluateExit(p,[],t+25*HOUR,s.config),null);
  const c={time:t+HOUR,closeTime:t+HOUR+59999,open:100,high:104,low:100,close:103};
  assert.equal(evaluateExit(p,[c],t+2*HOUR,s.config).reason,'target');
  const flat={...c,time:t+24*HOUR,closeTime:t+24*HOUR+59999,high:101,low:99,close:100};
  assert.equal(evaluateExit(p,[flat],t+25*HOUR,s.config).reason,'time');
});
test('sell proceeds and fee formulas are mathematically consistent',()=>{
  const c=createState().config,b=fillBuy(100,c),s=sellProceeds(b.quantity,100,c);
  assert.ok(s.net<c.allocation);
  assert.ok(Math.abs(s.net-b.quantity*100*(1-c.slippagePct/100)*(1-c.feePct/100))<1e-8);
});

// These formulas are validated against constructed price sequences, not market profitability.
test('RSI Wilder calculation returns correct limits for monotonic and flat prices',async()=>{
  const {rsi}=await import('../engine.mjs');
  assert.equal(rsi(Array.from({length:30},(_,i)=>100+i)),100);
  assert.equal(rsi(Array.from({length:30},(_,i)=>100-i)),0);
  assert.equal(rsi(Array(30).fill(100)),50);
  assert.ok(Number.isNaN(rsi([1,2,3])));
});
test('MACD, Bollinger and ATR indicators do not produce values without adequate history',async()=>{
  const {indicators,macd,bollinger}=await import('../engine.mjs');
  const sequence=Array.from({length:95},(_,i)=>100+i*.1);
  const m=macd(sequence),bands=bollinger(sequence);
  assert.ok(m.histogram>=-1e-9&&Number.isFinite(m.signal));
  assert.ok(bands.upper>bands.middle&&bands.middle>bands.lower&&bands.widthPct>0);
  assert.ok(Number.isNaN(macd([10,11]).signal));
  const last=indicators(series());
  assert.ok(Number.isFinite(last.rsi14));
  assert.ok(Number.isFinite(last.ema50));
  assert.ok(Number.isFinite(last.atrPct));
});
test('pre-breakout signals are based only on completed hourly candles and never trigger a paper entry',async()=>{
  const c=series({breakout:false});
  // Prior highs near 101; last candle approaches from below.
  c[59]={...c[59],open:100.4,high:100.85,low:100.35,close:100.75,volume:120};
  const a=analyse(c,0);
  assert.equal(a.stage,'approaching');
  assert.equal(a.trigger.breakout,false);
  assert.ok(a.distancePct>0&&a.distancePct<3);
  assert.ok(a.readinessScore>=0&&a.readinessScore<=100);
  assert.ok(a.proximity>0);
});
test('confirmed breakouts are classified separately from approaching resistance',()=>{
  const a=analyse(series({breakout:true}));
  assert.equal(a.stage,'confirmed');
  assert.ok(a.trigger.breakout);
  assert.ok(a.distancePct<0);
});

test('hourly candle cache remains valid between completed hourly closes',async()=>{
  const {hourlyCacheCurrent}=await import('../engine.mjs');
  const end=Date.UTC(2026,9,31,20,59,59,999);
  const bars=[{closeTime:end}];
  assert.equal(hourlyCacheCurrent(bars,end+10*60000),true);
  assert.equal(hourlyCacheCurrent(bars,end+3599999),true);
  assert.equal(hourlyCacheCurrent(bars,end+3601000),false);
  assert.equal(hourlyCacheCurrent([],end),false);
});
test('live price re-ranks pre-breakouts without creating or changing a closed hourly entry signal',async()=>{
  const {withLiveReadiness}=await import('../engine.mjs');
  const c=series({breakout:false});
  c[59]={...c[59],open:100.4,high:100.85,low:100.35,close:100.75,volume:120};
  const base=analyse(c,0);
  const near=withLiveReadiness(base,base.resistance*.99);
  const far=withLiveReadiness(base,base.resistance*.90);
  assert.equal(near.stage,'approaching');
  assert.equal(far.stage,'other');
  assert.ok(near.readinessScore>far.readinessScore);
  assert.equal(near.lastBarTime,base.lastBarTime);
  assert.deepEqual(near.trigger,base.trigger);
  assert.deepEqual(far.trigger,base.trigger);
});

test('combined paper P&L sums independent portfolios once and does not double-count grouped events',()=>{
  const state=createState();
  assert.deepEqual(paperPerformance(state),{realised:0,openEstimate:0,estimatedNet:0,openCount:0,closedCount:0,missingMarks:0,initial:50000});
  const at=Date.UTC(2026,9,31,22),signal=at-3600000;
  for(const strategy of ['breakout','volume','strength'])assert.equal(openPaper(state,strategy,'LAUSDT',0.058829,signal,at),true);
  const pending=paperPerformance(state,{});
  assert.equal(pending.openCount,3);
  assert.equal(pending.estimatedNet,null);
  assert.equal(pending.openEstimate,null);
  assert.equal(pending.missingMarks,3);
  const marked=paperPerformance(state,{LAUSDT:0.0593});
  assert.ok(Number.isFinite(marked.estimatedNet));
  assert.equal(marked.openCount,3);
  assert.equal(marked.missingMarks,0);
  for(const strategy of ['breakout','volume','strength'])closePaper(state,strategy,'LAUSDT',0.06005,'target',at+3600000);
  const finished=paperPerformance(state,{});
  const fromLedger=['breakout','volume','strength'].reduce((sum,id)=>sum+state.portfolios[id].trades[0].pnl,0);
  assert.ok(Math.abs(finished.realised-fromLedger)<1e-7);
  assert.ok(Math.abs(finished.estimatedNet-fromLedger)<1e-7);
  assert.equal(finished.openCount,0);
  assert.equal(finished.closedCount,3);
});