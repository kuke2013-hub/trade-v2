/* Breakout Laboratory research engine: pure, deterministic, no network or orders. */
export const STRATEGIES = [
  { id: 'breakout', name: 'Resistance breakout', description: 'Close clears the preceding 24-hour high.' },
  { id: 'volume', name: 'Volume confirmation', description: 'Breakout with unusually strong volume.' },
  { id: 'compression', name: 'Compression release', description: 'Quiet range expands into a confirmed breakout.' },
  { id: 'strength', name: 'Relative strength', description: 'Breakout with strong performance relative to BTC.' },
  { id: 'ml', name: 'Historical ML filter', description: 'Model probability must exceed its calibration-selected threshold AND holdout evidence gate. Only confirmed hourly breakouts are eligible for paper orders.' }
];
export const DEFAULT_CONFIG = Object.freeze({startingCash:10000, allocation:200, maxPositions:3, targetPct:2, stopPct:1.5, feePct:0.1, slippagePct:0.05, maxHoldHours:24});
const finite = x => Number.isFinite(x);
export function parseKlines(raw, now = Date.now()) {
  if (!Array.isArray(raw)) return [];
  return raw.map(r=>({time:+r[0],open:+r[1],high:+r[2],low:+r[3],close:+r[4],volume:+r[5],closeTime:+r[6]}))
    .filter(c=>[c.time,c.open,c.high,c.low,c.close,c.volume,c.closeTime].every(finite)&&c.open>0&&c.close>0&&c.low>0&&c.high>=Math.max(c.open,c.close,c.low)&&c.low<=Math.min(c.open,c.close)&&c.volume>=0&&c.closeTime<now)
    .sort((a,b)=>a.time-b.time).filter((c,i,arr)=>i===0||c.time!==arr[i-1].time);
}
export function sma(xs) { return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : NaN; }
export function ema(values,period){if(values.length<period)return NaN;let v=sma(values.slice(0,period));let alpha=2/(period+1);for(let i=period;i<values.length;i++)v=values[i]*alpha+v*(1-alpha);return v;}
export function atr(cs,period=14){if(cs.length<period+1)return NaN;const a=[];for(let i=cs.length-period;i<cs.length;i++){const x=cs[i],p=cs[i-1].close;a.push(Math.max(x.high-x.low,Math.abs(x.high-p),Math.abs(x.low-p)));}return sma(a);}
// Closed-candle indicators, with NaN for insufficient input; never substitute a fake value.
export function rsi(values,period=14){
  if(values.length<period+1)return NaN;
  let gain=0,loss=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];gain+=Math.max(d,0);loss+=Math.max(-d,0);}
  gain/=period;loss/=period;
  for(let i=period+1;i<values.length;i++){
    const d=values[i]-values[i-1];gain=(gain*(period-1)+Math.max(d,0))/period;loss=(loss*(period-1)+Math.max(-d,0))/period;
  }
  return loss===0?(gain===0?50:100):100-100/(1+gain/loss);
}
export function emaSeries(values,period){
  const out=Array(values.length).fill(NaN);
  if(values.length<period)return out;
  let value=sma(values.slice(0,period));out[period-1]=value;
  for(let i=period;i<values.length;i++){value=values[i]*(2/(period+1))+value*(1-2/(period+1));out[i]=value;}
  return out;
}
export function macd(values){
  const fast=emaSeries(values,12),slow=emaSeries(values,26);
  const points=fast.map((v,i)=>finite(v)&&finite(slow[i])?v-slow[i]:NaN).filter(finite);
  const signal=ema(points,9),line=points.at(-1);
  return {line,signal,histogram:finite(line)&&finite(signal)?line-signal:NaN};
}
export function bollinger(values,period=20,multiple=2){
  if(values.length<period)return {middle:NaN,upper:NaN,lower:NaN,widthPct:NaN};
  const recent=values.slice(-period),middle=sma(recent);
  const sd=Math.sqrt(sma(recent.map(v=>(v-middle)**2)));
  const upper=middle+multiple*sd,lower=middle-multiple*sd;
  return {middle,upper,lower,widthPct:middle>0?(upper-lower)/middle*100:NaN};
}
export function indicators(bars){
  const closes=bars.map(c=>c.close),close=closes.at(-1);
  const atr14=atr(bars,14),m=macd(closes);
  return {ema9:ema(closes,9),ema21:ema(closes,21),ema50:ema(closes,50),rsi14:rsi(closes),macd:m,bollinger:bollinger(closes),atr14,atrPct:finite(atr14)&&close>0?100*atr14/close:NaN};
}
const clamp=(x,min,max)=>Math.max(min,Math.min(max,x));
// Ranking only: a pre-breakout research heuristic, not a statistically calibrated chance of profit.
export function breakoutReadiness({close,resistance,trend,compression,volumeRatio,relative,technical,breakout}){
  const distancePct=resistance>0?(resistance-close)/resistance*100:NaN;
  const r=technical.rsi14,m=technical.macd.histogram;
  const emerging=finite(distancePct)&&distancePct>0&&distancePct<=3&&(trend||(finite(r)&&r>=53&&r<=72&&finite(m)&&m>0&&volumeRatio>=1.1));
  const stage=breakout?'confirmed':emerging?'approaching':finite(distancePct)&&distancePct>0&&distancePct<=7?'watch':'other';
  const proximity=finite(distancePct)?clamp(100*(1-distancePct/3),0,100):0;
  const trendScore=trend?14:0;
  const rsiScore=finite(r)&&r>=48&&r<=70?10:finite(r)&&r>70&&r<=78?3:0;
  const macdScore=finite(m)&&m>0?8:0;
  const volumeScore=clamp(volumeRatio*6,0,12);
  const relativeScore=clamp(relative*2,0,12);
  const readinessScore=Math.round(clamp(proximity*.42+trendScore+rsiScore+macdScore+volumeScore+relativeScore+(compression?12:0),0,100));
  return {distancePct,stage,readinessScore,proximity,volumeMeter:clamp(volumeRatio*50,0,100),rsiMeter:finite(r)?clamp(r,0,100):null};
}
// The latest completed 1h candle is unchanged until the NEXT hourly candle closes.
// A fresh 24-hour ticker is still requested every minute to update pre-breakout distance.
export function hourlyCacheCurrent(bars,now=Date.now()){
  const last=Array.isArray(bars)?bars.at(-1):null;
  return !!last&&finite(last.closeTime)&&finite(now)&&now<last.closeTime+3600000+1000;
}
// Live price affects DISPLAY/RANKING ONLY; the actual trade triggers remain on closed 1h bars.
export function withLiveReadiness(closedAnalysis,lastTradedPrice){
  if(!closedAnalysis||!finite(lastTradedPrice)||lastTradedPrice<=0)return closedAnalysis;
  const a=closedAnalysis;
  const live=breakoutReadiness({close:lastTradedPrice,resistance:a.resistance,trend:a.trend,
    compression:a.compression,volumeRatio:a.volumeRatio,relative:a.relative,
    technical:a.technical,breakout:a.breakout});
  return {...a,...live,livePrice:lastTradedPrice};
}
export function analyse(candles,btcReturn24h=0){
  const c=candles, n=c.length;
  if(n<55)return null;
  // Prevent treating hours-long exchange data gaps as consecutive observations.
  for(let i=n-54;i<n;i++)if(c[i].time-c[i-1].time!==3600000)return null;
  const last=c[n-1], prior=c.slice(n-25,n-1), prev20=c.slice(n-21,n-1);
  const resistance=Math.max(...prior.map(x=>x.high));
  const avgVol=sma(prev20.map(x=>x.volume));
  const volumeRatio=avgVol>0?last.volume/avgVol:0;
  const closeLocation=last.high>last.low?(last.close-last.low)/(last.high-last.low):0.5;
  const closes=c.map(x=>x.close);
  const trend=ema(closes,9)>ema(closes,21)&&ema(closes,21)>ema(closes,50);
  const breakout=last.close>resistance*1.001&&closeLocation>=0.60;
  const coin24h=c[n-25].close>0?(last.close/c[n-25].close-1)*100:0;
  const relative=coin24h-btcReturn24h;
  const recentRanges=c.slice(n-9,n-1).map(x=>(x.high-x.low)/x.close);
  const oldRanges=c.slice(n-33,n-9).map(x=>(x.high-x.low)/x.close);
  const compression=sma(recentRanges)<sma(oldRanges)*0.8;
  const trigger={breakout,volume:breakout&&volumeRatio>=1.5,compression:breakout&&compression&&volumeRatio>=1.2,strength:breakout&&relative>=3&&trend};
  const technical=indicators(c);
  const readiness=breakoutReadiness({close:last.close,resistance,trend,compression,volumeRatio,relative,technical,breakout});
  // Existing hourly breakout score is retained for confirmed-signal sorting and paper entries.
  const setup=Math.round(Math.min(100,Math.max(0,(breakout?34:0)+(trend?18:0)+Math.min(20,volumeRatio*7)+(compression?12:0)+Math.min(16,Math.max(0,relative)*2))));
  return {resistance,volumeRatio,closeLocation,trend,breakout,compression,relative,coin24h,atr:technical.atr14,score:setup,technical,...readiness,trigger,lastBarTime:last.closeTime,close:last.close,volume:last.volume};
}
export function createState(config=DEFAULT_CONFIG){return {version:1,config:{...DEFAULT_CONFIG,...config},portfolios:Object.fromEntries(STRATEGIES.map(s=>[s.id,{cash:config.startingCash??DEFAULT_CONFIG.startingCash,positions:[],trades:[],seenSignals:{}}])),createdAt:Date.now(),updatedAt:Date.now()};}
export function fillBuy(quote,config){const execution=quote*(1+config.slippagePct/100);const feeRate=config.feePct/100;return {execution,quantity:(config.allocation/(1+feeRate))/execution,entryFee:config.allocation*feeRate/(1+feeRate)};}
export function sellProceeds(quantity,marketPrice,config){const execution=marketPrice*(1-config.slippagePct/100);const gross=quantity*execution;return {execution,gross,fee:gross*config.feePct/100,net:gross*(1-config.feePct/100)};}
export function openPaper(state,strategyId,symbol,price,signalBar,at=Date.now()){
  const p=state.portfolios[strategyId],cfg=state.config;
  if(!p||!finite(price)||price<=0||!finite(at)||!finite(signalBar))return false;
  if(p.positions.length>=cfg.maxPositions||p.positions.some(x=>x.symbol===symbol)||p.cash<cfg.allocation)return false;
  const key=symbol+':'+signalBar;
  if(p.seenSignals[key])return false;
  const buy=fillBuy(price,cfg);
  p.cash-=cfg.allocation;p.seenSignals[key]=1;
  p.positions.push({symbol,strategyId,entryTime:at,entryMarket:price,entryPrice:buy.execution,quantity:buy.quantity,entryFee:buy.entryFee,cost:cfg.allocation,signalBar,lastChecked:at,status:'open'});
  state.updatedAt=at;return true;
}
export function evaluateExit(position,minuteCandles,now,config){
  const tp=position.entryPrice*(1+config.targetPct/100)/(1-config.slippagePct/100);
  const sl=position.entryPrice*(1-config.stopPct/100)/(1-config.slippagePct/100);
  const bars=minuteCandles.filter(c=>c.time>=position.entryTime&&c.closeTime<=now).sort((a,b)=>a.time-b.time);
  for(const bar of bars){
    // Conservative: if both extremes occurred in one minute, assume STOP first.
    if(bar.low<=sl)return {reason:'stop',market:sl,at:bar.closeTime};
    if(bar.high>=tp)return {reason:'target',market:tp,at:bar.closeTime};
  }
  if(now-position.entryTime>=config.maxHoldHours*3600000&&bars.length){const last=bars[bars.length-1];if(last.closeTime>=position.entryTime+config.maxHoldHours*3600000-60000)return {reason:'time',market:last.close,at:last.closeTime};}
  return null;
}
export function closePaper(state,strategyId,symbol,market,reason,at=Date.now()){
  const p=state.portfolios[strategyId],i=p?.positions.findIndex(x=>x.symbol===symbol)??-1;
  if(i<0||!finite(market)||market<=0||!finite(at))return null;
  const position=p.positions.splice(i,1)[0],sale=sellProceeds(position.quantity,market,state.config);
  p.cash+=sale.net;
  const trade={...position,exitMarket:market,exitPrice:sale.execution,exitFee:sale.fee,exitTime:at,reason,proceeds:sale.net,pnl:sale.net-position.cost,returnPct:100*(sale.net/position.cost-1)};
  p.trades.push(trade);state.updatedAt=at;return trade;
}
export function portfolioStats(portfolio,marks={},config=DEFAULT_CONFIG){
  const completed=portfolio.trades;
  const realised=completed.reduce((a,x)=>a+x.pnl,0);
  const wins=completed.filter(x=>x.pnl>0).length;
  const openValue=portfolio.positions.reduce((a,x)=>a+(finite(marks[x.symbol])?sellProceeds(x.quantity,marks[x.symbol],config).net:x.cost),0);
  const grossProfit=completed.filter(t=>t.pnl>0).reduce((a,t)=>a+t.pnl,0);
  const grossLoss=-completed.filter(t=>t.pnl<0).reduce((a,t)=>a+t.pnl,0);
  return {realised,trades:completed.length,wins,winRate:completed.length?100*wins/completed.length:null,profitFactor:grossLoss?grossProfit/grossLoss:null,estimatedEquity:portfolio.cash+openValue,openCount:portfolio.positions.length};
}

// Portfolio-level paper P&L presentation only. Never merges or duplicates trades.
// A missing mark on ANY open position makes the estimated fields unavailable.
export function paperPerformance(state, marks={}){
  const portfolios=STRATEGIES.map(s=>state.portfolios[s.id]);
  const initial=STRATEGIES.length*state.config.startingCash;
  const realised=portfolios.reduce((sum,p)=>sum+p.trades.reduce((v,t)=>v+t.pnl,0),0);
  const openCount=portfolios.reduce((sum,p)=>sum+p.positions.length,0);
  const closedCount=portfolios.reduce((sum,p)=>sum+p.trades.length,0);
  const missingMarks=portfolios.reduce((sum,p)=>sum+p.positions.filter(t=>!Number.isFinite(marks[t.symbol])||marks[t.symbol]<=0).length,0);
  const estimatedNet=missingMarks?null:portfolios.reduce((sum,p)=>sum+portfolioStats(p,marks,state.config).estimatedEquity,0)-initial;
  return {realised,openEstimate:estimatedNet===null?null:estimatedNet-realised,estimatedNet,openCount,closedCount,missingMarks,initial};
}