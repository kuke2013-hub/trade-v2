import test from 'node:test';
import assert from 'node:assert/strict';
import {mlFeatures,validateModel,probability,modelAllowsPaper,FEATURES} from '../ml.mjs';

function bars(){
  const start=Date.UTC(2023,0,1);
  return Array.from({length:95},(_,i)=>{
    const p=100+i*.03+(i%3===0?.1:-.1);
    return {time:start+i*3600000,open:p-.12,high:p+.50,low:p-.51,close:p,volume:100+i%7,
            closeTime:start+(i+1)*3600000-1};
  });
}
test('ML is unavailable without real model and hourly/BTC history',()=>{
  assert.equal(mlFeatures([],[]),null);
  assert.equal(validateModel(null),false);
  assert.equal(modelAllowsPaper(null,.99),false);
});
test('live ML feature engine uses closed, contiguous hourly bars with aligned BTC',()=>{
  const a=bars(),f=mlFeatures(a,a);
  assert.ok(f,'valid nearby resistance candidate');
  assert.deepEqual(Object.keys(f),FEATURES);
  assert.ok(Object.values(f).every(Number.isFinite));
  const future=[...a];future.at(-2).time+=2000;
  assert.equal(mlFeatures(future,a),null,'gapped history cannot generate a probability');
  const btc=bars();btc.at(-1).time+=3600000;
  assert.equal(mlFeatures(a,btc),null,'timestamp misalignment is rejected');
  const far=a.map(v=>({...v}));far.at(-1).close=1;far.at(-1).low=0.9;
  assert.equal(mlFeatures(far,a),null,'noncandidate is not ML-scored');
});
test('logistic inference is deterministic and requires the accepted holdout gate before trading',()=>{
  const m={schema:'breakout-v2-1',trained_on:'Binance Vision spot 1h',features:[...FEATURES],kind:'logistic',
    means:FEATURES.map(()=>0),scales:FEATURES.map(()=>1),coef:FEATURES.map(()=>0),bias:1,
    calibration:{a:1,b:0},threshold:.55,holdout:{brier:.12,baseline_brier:.15,accepted:false}};
  assert.equal(validateModel(m),true);
  const features=Object.fromEntries(FEATURES.map(n=>[n,0]));
  const p=probability(m,features);assert.ok(Math.abs(p-.73105857863)<1e-10);
  assert.equal(modelAllowsPaper(m,p),false);
  assert.equal(modelAllowsPaper({...m,holdout:{...m.holdout,accepted:true}},p),true);
  assert.equal(modelAllowsPaper({...m,holdout:{...m.holdout,accepted:true}},.3),false);
});
test('gradient boost inference reproduces a transparent two-leaf tree',()=>{
  const tree=[{f:0,t:0,l:1,r:2,v:0},{f:-1,t:0,l:-1,r:-1,v:-1},{f:-1,t:0,l:-1,r:-1,v:1}];
  const m={schema:'breakout-v2-1',trained_on:'Binance Vision spot 1h',features:[...FEATURES],kind:'gradient_boosting',
    means:FEATURES.map(()=>0),scales:FEATURES.map(()=>1),trees:[tree],init_logodds:0,learning_rate:1,
    threshold:.5,holdout:{brier:.12,baseline_brier:.15,accepted:true}};
  const f=Object.fromEntries(FEATURES.map(n=>[n,0]));
  f.distance_pct=-1;
  assert.ok(Math.abs(probability(m,f)-.26894142137)<1e-9);
  f.distance_pct=1;
  assert.ok(Math.abs(probability(m,f)-.73105857863)<1e-9);
});