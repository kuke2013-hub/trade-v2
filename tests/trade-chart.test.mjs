import test from 'node:test';
import assert from 'node:assert/strict';
import {tradeKey,recordedTrades,tradeLevels,tradeMinuteWindow,minuteMarkerPosition,groupPaperEvents} from '../trade-chart.mjs';
import {DEFAULT_CONFIG} from '../engine.mjs';

test('only actual paper trade records are available for chart markers',()=>{
  const open={symbol:'MOMUSDT',strategyId:'breakout',entryTime:1700000000000,entryPrice:100};
  const closed={symbol:'MOMUSDT',strategyId:'volume',entryTime:1699990000000,entryPrice:101,exitTime:1700000040000,exitPrice:104};
  const s={portfolios:{breakout:{positions:[open],trades:[]},volume:{positions:[],trades:[closed]},strength:{positions:[],trades:[{symbol:'OTHERUSDT',entryTime:1700000000000,entryPrice:102}]}}};
  const trades=recordedTrades(s,'MOMUSDT');
  assert.equal(trades.length,2);
  assert.equal(trades[0].strategyId,'breakout');
  assert.equal(trades[1].exitPrice,104);
  assert.equal(recordedTrades(s,'OTHERUSDT').length,1);
  assert.equal(recordedTrades({portfolios:{}},'NOUSDT').length,0);
  assert.equal(tradeKey(open),'breakout|MOMUSDT|1700000000000');
});

test('stop and target lines reflect exact trigger quote including simulated slippage',()=>{
  const trade={entryPrice:100,entryTime:1700000000000,exitPrice:101.85,exitTime:1700000060000};
  const levels=tradeLevels(trade,DEFAULT_CONFIG);
  assert.ok(Math.abs(levels.stopTrigger*(1-DEFAULT_CONFIG.slippagePct/100)-98.5)<1e-10);
  assert.ok(Math.abs(levels.targetTrigger*(1-DEFAULT_CONFIG.slippagePct/100)-102)<1e-10);
  assert.equal(levels.entry,100);
  assert.equal(levels.exit,101.85);
  assert.equal(tradeLevels({...trade,entryPrice:-1},DEFAULT_CONFIG),null);
});

test('minute windows are anchored to the real entry or exit timestamp and never look into future',()=>{
  const t={entryTime:1700000000000,exitTime:1700006000000};
  const now=1700010000000;
  const entry=tradeMinuteWindow(t,'entry',now);
  assert.equal(entry.startTime,t.entryTime-30*60000);
  assert.equal(entry.endTime,t.entryTime+150*60000);
  const exit=tradeMinuteWindow(t,'exit',now);
  assert.equal(exit.startTime,t.exitTime-120*60000);
  assert.equal(exit.endTime,t.exitTime+60*60000);
  assert.throws(()=>tradeMinuteWindow({entryTime:t.entryTime},'exit'),/has not exited/);
});

test('event markers map to the actual one-minute candle and remain absent across missing minutes',()=>{
  const base=1700000000000;
  const bars=[0,1,3].map(i=>({time:base+i*60000,closeTime:base+(i+1)*60000-1}));
  const x=minuteMarkerPosition(bars,base+30000,10,310);
  assert.ok(Math.abs(x-60)<1e-6);
  assert.equal(minuteMarkerPosition(bars,base+2*60000+1000),null);
  assert.equal(minuteMarkerPosition(bars,base-1),null);
  assert.equal(minuteMarkerPosition(bars,base+3*60000+1000,10,310)>200,true);
});

test('one market signal is displayed as one event while retaining each strategy position',()=>{
  const base={symbol:'LAUSDT',signalBar:1770000000000,entryTime:1770000010000,entryPrice:.058829,exitTime:1770004800000,exitPrice:.060006,reason:'target',pnl:3.59,cost:200};
  const records=['breakout','volume','strength'].map((id,i)=>({...base,strategyId:id,entryTime:base.entryTime+i}));
  const groups=groupPaperEvents(records);
  assert.equal(groups.length,1);
  assert.equal(groups[0].trades.length,3);
  assert.deepEqual(groups[0].strategyIds,['breakout','volume','strength']);
  assert.ok(Math.abs(groups[0].realisedPnl-10.77)<1e-9);
  assert.equal(groups[0].allocation,600);
  assert.equal(groups[0].entryPrice,.058829);
  assert.equal(groups[0].status,'target');
  // No trades or accounting records are removed or altered by grouping.
  assert.equal(records.length,3);
  assert.equal(records[1].pnl,3.59);
});

test('different signal candles and missing signal IDs never get incorrectly grouped',()=>{
  const a={symbol:'LAUSDT',strategyId:'breakout',signalBar:1770000000000,entryTime:1770000010000,entryPrice:1};
  const b={...a,strategyId:'volume',signalBar:a.signalBar+3600000,entryTime:a.entryTime+3600000};
  const c={...a,strategyId:'strength',signalBar:undefined,entryTime:a.entryTime};
  const d={...a,strategyId:'volume',signalBar:undefined,entryTime:a.entryTime};
  const groups=groupPaperEvents([a,b,c,d]);
  assert.equal(groups.length,4);
  assert.ok(groups.every(g=>g.trades.length===1));
});

test('one event with mixed open/closed positions reports realised P&L without inventing exits',()=>{
  const a={symbol:'MOMUSDT',strategyId:'breakout',signalBar:1770000000000,entryTime:1770000010000,entryPrice:1,exitPrice:1.02,exitTime:1770002000000,pnl:3.5,reason:'target',cost:200};
  const b={...a,strategyId:'volume',exitPrice:undefined,exitTime:undefined,pnl:undefined,reason:undefined};
  const group=groupPaperEvents([a,b])[0];
  assert.equal(group.status,'MIXED');
  assert.equal(group.realisedPnl,3.5);
  assert.equal(group.openCount,1);
  assert.equal(group.closedCount,1);
  assert.equal(group.exitPrice,null);
  assert.equal(group.entryPrice,1);
});