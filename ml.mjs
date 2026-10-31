/* V2 historical ML inference. Features must exactly mirror research/pipeline.py.
   Never infer trained probabilities without a checksummed historical model artefact. */
import {atr} from './engine.mjs';

export const FEATURES = Object.freeze([
  'distance_pct','return_1h','return_4h','return_24h','btc_24h','relative_24h',
  'volume_ratio','range_pct','close_location','compression_ratio','sma9_21_pct',
  'sma21_50_pct','atr_pct','quote_volume_log','confirmed'
]);
export const BOUNDS = Object.freeze([
  [-3,3],[-40,40],[-60,60],[-100,250],[-40,60],[-200,200],
  [0,100],[0,100],[0,1],[0,8],[-50,50],[-60,60],[0,100],[0,15],[0,1]
]);
const mean=arr=>arr.reduce((a,b)=>a+b,0)/arr.length;
const cap=(n,i)=>Math.max(BOUNDS[i][0],Math.min(BOUNDS[i][1],n));
const ret=(a,b)=>100*(a/b-1);
export function mlFeatures(hourly,btcHourly){
  if(!Array.isArray(hourly)||!Array.isArray(btcHourly)||hourly.length<55||btcHourly.length<25)return null;
  const a=hourly.at(-1),b=btcHourly.at(-1);
  if(!a||!b||a.time!==b.time||a.close<=0||b.close<=0)return null;
  const n=hourly.length;
  for(let k=n-54;k<n;k++)if(hourly[k].time-hourly[k-1].time!==3600000)return null;
  for(let k=btcHourly.length-24;k<btcHourly.length;k++)if(btcHourly[k].time-btcHourly[k-1].time!==3600000)return null;
  const res=Math.max(...hourly.slice(-25,-1).map(v=>v.high));
  if(!(res>0))return null;
  const distance=100*(res-a.close)/res;
  if(distance < -3||distance > 3)return null; // historical training cohort
  const prev20=hourly.slice(-21,-1).map(v=>v.volume),volMean=mean(prev20);
  const range=v=>(v.high-v.low)/v.close;
  const recent=mean(hourly.slice(-9,-1).map(range));
  const previous=mean(hourly.slice(-33,-9).map(range));
  const closeLoc=a.high>a.low?(a.close-a.low)/(a.high-a.low):.5;
  const s9=mean(hourly.slice(-9).map(v=>v.close));
  const s21=mean(hourly.slice(-21).map(v=>v.close));
  const s50=mean(hourly.slice(-50).map(v=>v.close));
  const btc24=ret(b.close,btcHourly.at(-25).close);
  const this24=ret(a.close,hourly.at(-25).close);
  const values=[distance,ret(a.close,hourly.at(-2).close),ret(a.close,hourly.at(-5).close),this24,btc24,this24-btc24,
    volMean>0?a.volume/volMean:0,100*range(a),closeLoc,previous>0?recent/previous:0,
    ret(s9,s21),ret(s21,s50),100*atr(hourly,14)/a.close,Math.log10(Math.max(1,a.close*a.volume)),
    a.close>res*1.001&&closeLoc>=.60?1:0
  ];
  if(values.some(x=>!Number.isFinite(x)))return null;
  return Object.fromEntries(FEATURES.map((name,i)=>[name,cap(values[i],i)]));
}
const logistic=x=>x>=0?1/(1+Math.exp(-x)):Math.exp(x)/(1+Math.exp(x));
function treeEval(tree,values){let idx=0;for(let steps=0;steps<80;steps++){
    const node=tree[idx];if(!node)throw new Error('Invalid model tree');
    if(node.f===-1)return node.v;
    idx=values[node.f]<=node.t?node.l:node.r;
  }throw new Error('Invalid model tree depth');}
export function validateModel(m){
  if(!m||m.schema!=='breakout-v2-1'||m.trained_on!=='Binance Vision spot 1h' || !Array.isArray(m.features) ||m.features.join('|')!==FEATURES.join('|'))return false;
  if(!m.holdout||!Number.isFinite(m.holdout.brier)||!Number.isFinite(m.holdout.baseline_brier)||!Number.isFinite(m.threshold))return false;
  if(!Array.isArray(m.means)||!Array.isArray(m.scales)||m.means.length!==FEATURES.length||m.scales.length!==FEATURES.length)return false;
  if(!m.means.every(Number.isFinite)||!m.scales.every(x=>Number.isFinite(x)&&x>0))return false;
  if(!['logistic','gradient_boosting'].includes(m.kind))return false;
  if(m.kind==='logistic')return Array.isArray(m.coef)&&m.coef.length===FEATURES.length&&m.coef.every(Number.isFinite)&&Number.isFinite(m.bias);
  return Array.isArray(m.trees)&&m.trees.length>0&&m.trees.length<=300&&m.trees.every(t=>Array.isArray(t)&&t.length>0&&t.length<2048)&&Number.isFinite(m.init_logodds)&&Number.isFinite(m.learning_rate);
}
export function probability(m,f){
  if(!validateModel(m)||!f)return null;
  const v=FEATURES.map((n,i)=>(f[n]-m.means[i])/m.scales[i]);
  if(v.some(x=>!Number.isFinite(x)))return null;
  const score=m.kind==='logistic'?m.bias+m.coef.reduce((s,w,i)=>s+w*v[i],0)
    :m.init_logodds+m.learning_rate*m.trees.reduce((s,t)=>s+treeEval(t,v),0);
  const calibrated=Number.isFinite(m.calibration?.a)&&Number.isFinite(m.calibration?.b)?m.calibration.a*score+m.calibration.b:score;
  return logistic(calibrated);
}
export function modelAllowsPaper(m,p){return !!(validateModel(m)&&m.holdout?.accepted===true&&Number.isFinite(p)&&p>=m.threshold);}