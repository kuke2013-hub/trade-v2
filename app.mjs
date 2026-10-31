import {STRATEGIES,DEFAULT_CONFIG,parseKlines,analyse,hourlyCacheCurrent,withLiveReadiness,createState,openPaper,closePaper,evaluateExit,portfolioStats,paperPerformance,indicators,emaSeries} from './engine.mjs';
import {tradeKey,recordedTrades,tradeLevels,tradeMinuteWindow,minuteMarkerPosition,groupPaperEvents} from './trade-chart.mjs';
import {mlFeatures,validateModel,probability,modelAllowsPaper} from './ml.mjs';
const API='https://data-api.binance.vision/api/v3/';
// Display-only candle intervals. Strategy signals and trade entries continue to use completed 1h bars.
const CHART_LABELS=Object.freeze({'1M':'1 month','1w':'1 week','1d':'1 day','1h':'1 hour','5m':'5 minutes','3m':'3 minutes','1m':'1 minute'});
const savedInterval=localStorage.getItem('breakout-v2-chart-interval');
let chartInterval=Object.hasOwn(CHART_LABELS,savedInterval)?savedInterval:'1h';
let detailInterval=chartInterval,detailSymbol=null,detailRequest=0,selectedTradeKey=null,tradeWindow='entry';
const displayCandles=new Map(),displayInFlight=new Map();
// Intervals are whitelisted above. Cache keys include symbol + interval to prevent cross-timeframe corruption.
function displayKey(symbol,interval){return `${symbol}|${interval}`;}
function displayCacheMs(interval){return ['1m','3m','5m'].includes(interval)?40000:180000;}
async function loadDisplayBars(symbol,interval,force=false){
  if(!Object.hasOwn(CHART_LABELS,interval))throw new Error('Unsupported candle interval');
  const key=displayKey(symbol,interval),cached=displayCandles.get(key);
  if(cached&&!force&&Date.now()-cached.when<displayCacheMs(interval))return cached.bars;
  if(displayInFlight.has(key))return displayInFlight.get(key);
  const request=(async()=>{
    const raw=await json(`klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=95`);
    // An in-progress candle is appropriate for a display, but NEVER passed to analyse()/trade signals.
    const bars=parseKlines(raw,Infinity);
    if(bars.length<2)throw new Error(`Insufficient ${CHART_LABELS[interval]} candles for ${symbol}`);
    displayCandles.set(key,{when:Date.now(),bars});
    return bars;
  })();
  displayInFlight.set(key,request);
  try{return await request;}finally{displayInFlight.delete(key);}
}
// Historical 1m candles around a recorded trade, rather than the last 95 minutes.
// A newly opened trade is refreshed frequently; historical closed trades can be cached.
const tradeMinuteCache=new Map();
async function loadTradeMinuteBars(symbol,trade,windowMode,force=false){
  const range=tradeMinuteWindow(trade,windowMode),key=`${symbol}|${tradeKey(trade)}|${windowMode}|${trade.exitTime??'open'}`;
  const cached=tradeMinuteCache.get(key),ttl=trade.exitTime?600000:30000;
  if(cached&&!force&&Date.now()-cached.when<ttl)return cached.bars;
  const raw=await json(`klines?symbol=${encodeURIComponent(symbol)}&interval=1m&startTime=${range.startTime}&endTime=${range.endTime}&limit=180`);
  const bars=parseKlines(raw,Infinity);
  if(bars.length<2)throw new Error('Insufficient Binance minute data around this paper trade');
  tradeMinuteCache.set(key,{when:Date.now(),bars});
  return bars;
}
function activeTrade(){return recordedTrades(paper,detailSymbol).find(t=>tradeKey(t)===selectedTradeKey)||null;}
function timeUTC(t){return Number.isFinite(t)?new Date(t).toISOString().replace('T',' ').slice(0,19)+' UTC':'—';}
function renderTradeControls(){
  const section=$('detail-paper'),select=$('detail-trade-select'),hint=$('detail-paper-hint');
  const trades=recordedTrades(paper,detailSymbol);
  section.hidden=false;
  if(!trades.length){selectedTradeKey=null;select.hidden=true;$('detail-trade-windows').hidden=true;$('detail-trade-summary').hidden=true;hint.textContent='No paper entry is recorded for this pair in this browser. A breakout signal alone is NOT a paper trade.';return null;}
  if(!trades.some(t=>tradeKey(t)===selectedTradeKey))selectedTradeKey=tradeKey(trades[0]);
  select.hidden=false;select.innerHTML=trades.map(t=>`<option value="${escape(tradeKey(t))}">${escape(STRATEGIES.find(s=>s.id===t.strategyId)?.name||t.strategyId)} · ${escape(timeUTC(t.entryTime))} · ${t.exitTime?'CLOSED':'OPEN'}</option>`).join('');
  select.value=selectedTradeKey;
  $('detail-trade-windows').hidden=detailInterval!=='1m';
  hint.textContent=detailInterval==='1m'?'Exact paper-fill timestamps and levels. Choose ENTRY or EXIT window to inspect a trade outside the most recent candles.':'Select 1m to see exact simulated trade markers on Binance minute candles.';
  const trade=trades.find(t=>tradeKey(t)===selectedTradeKey),levels=tradeLevels(trade,paper.config);
  $('detail-trade-summary').hidden=false;
  $('detail-trade-summary').innerHTML=`<span><strong>SIM BUY</strong> ${num(levels.entry,6)} · ${escape(timeUTC(levels.entryTime))}</span><span><strong>STOP TRIGGER</strong> ${num(levels.stopTrigger,6)}</span><span><strong>TAKE PROFIT TRIGGER</strong> ${num(levels.targetTrigger,6)}</span><span><strong>${levels.exitTime?'SIM SELL':'POSITION'}</strong> ${levels.exitTime?num(levels.exit,6)+' · '+escape(timeUTC(levels.exitTime)):'OPEN'}</span>`;
  $('trade-window-exit').disabled=!levels.exitTime;
  for(const button of $('detail-trade-windows').querySelectorAll('button[data-window]'))button.classList.toggle('active',button.dataset.window===tradeWindow);
  return trade;
}
function selectInterval(container,interval){
  document.querySelectorAll(`#${container} [data-interval]`).forEach(b=>{
    const active=b.dataset.interval===interval;
    b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));
  });
}
function drawChartError(canvas,message){const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#bfbfbf';ctx.font='20px monospace';ctx.fillText(message,18,Math.round(canvas.height*.5));}

const $=id=>document.getElementById(id);
const quote=s=>String(s).replace(/USDT$/,'');
const num=(n,d=2)=>Number.isFinite(+n)?Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
const pct=n=>Number.isFinite(+n)?`${+n>=0?'+':''}${num(n,2)}%`:'—';
const cash=n=>Number.isFinite(n)?`${n<0?'-':''}$${num(Math.abs(n),2)}`:'—';
const escape=s=>String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
let markets=[],bySymbol=new Map(),candles=new Map(),scores=new Map(),busy=false,observer=null,scannedAt=0,ready=false;
let historicalModel=null,modelError='Training has not yet produced a verified model artefact.';
const SCAN_EVERY_MS=60000;
let exchangeCache=null;
const visibleSymbols=new Set();let chartRefreshBusy=false,shortRefreshAt=0;
let armed=localStorage.getItem('breakout-v2-armed')==='yes';
let paper;
try{const v=JSON.parse(localStorage.getItem('breakout-v2-paper-1'));paper=v?.version===1&&v.portfolios&&v.config? v:createState();}catch{paper=createState();}
function save(){try{localStorage.setItem('breakout-v2-paper-1',JSON.stringify(paper));}catch(err){showError('Browser storage is unavailable. Paper trades may disappear after reloading. '+err.message);}}
function showError(message){$('error-banner').hidden=false;$('error-banner').textContent='DATA / EXECUTION WARNING — '+message;$('connection').classList.remove('live');$('connection').innerHTML='<span class="status-dot"></span>DEGRADED';}
function clearError(){$('error-banner').hidden=true;}
function status(text){$('scan-status').textContent=text;}
function setLive(){$('connection').classList.add('live');$('connection').innerHTML='<span class="status-dot"></span>CONNECTED · SPOT';}
async function json(path,timeout=18000){const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),timeout);try{const r=await fetch(API+path,{signal:ctl.signal,cache:'no-store'});if(!r.ok)throw new Error(`Binance HTTP ${r.status} for ${path.split('?')[0]}`);return await r.json();}finally{clearTimeout(timer);}}
async function loadExchangeInfo(){
  if(exchangeCache&&Date.now()-exchangeCache.when<3600000)return exchangeCache.data;
  const info=await json('exchangeInfo');
  if(!info?.symbols)throw new Error('Unexpected Binance exchangeInfo response');
  exchangeCache={when:Date.now(),data:info};
  return info;
}
async function universe(){
  // Live 24h market prices are retrieved every scan; static symbol metadata is cached for an hour.
  const [info,tickers]=await Promise.all([loadExchangeInfo(),json('ticker/24hr')]);
  if(!info?.symbols||!Array.isArray(tickers))throw new Error('Unexpected Binance exchangeInfo/ticker response');
  const valid=new Set(info.symbols.filter(s=>s.quoteAsset==='USDT'&&s.status==='TRADING'&&s.isSpotTradingAllowed!==false).map(s=>s.symbol));
  const bad=/((UP|DOWN|BULL|BEAR)USDT)$/;const stable=/^(USDC|FDUSD|TUSD|DAI|USDP|USDE|EUR|EURI|BRL|TRY|AEUR|USD1)USDT$/;
  markets=tickers.filter(t=>valid.has(t.symbol)&&!bad.test(t.symbol)&&!stable.test(t.symbol)&&Number(t.quoteVolume)>=500000&&Number(t.lastPrice)>0).map(t=>({symbol:t.symbol,price:+t.lastPrice,change:+t.priceChangePercent,volume:+t.quoteVolume}));
  markets.sort((a,b)=>b.volume-a.volume);markets=markets.slice(0,360);bySymbol=new Map(markets.map(m=>[m.symbol,m]));
  if(!markets.length)throw new Error('No liquid tradable USDT pairs were returned');
  $('metric-pairs').textContent=markets.length;$('pair-count').textContent=markets.length;
}
function renderModelStatus(){
  const m=historicalModel;
  const $x=id=>document.getElementById(id);
  $x('ml-status').textContent=m?(m.holdout.accepted?'TRAINED · OUT-OF-SAMPLE PAPER GATE PASSED':'TRAINED · NO ACCEPTED PAPER EDGE'):'UNTRAINED · RESEARCH PIPELINE PENDING';
  $x('ml-status').dataset.state=m?(m.holdout.accepted?'accepted':'rejected'):'untrained';
  $x('ml-coverage').textContent=m?`${m.coverage?.symbols??'?'} HISTORICAL PAIRS · ${(m.coverage?.observations??0).toLocaleString()} LABELLED EVENTS`:'NO HISTORICAL TRAINING OBSERVATIONS LOADED';
  $x('ml-model').textContent=m?m.kind.replace('_',' ').toUpperCase():'—';
  $x('ml-brier').textContent=m?`${m.holdout.brier.toFixed(4)} / ${m.holdout.baseline_brier.toFixed(4)} BASELINE`:'—';
  $x('ml-threshold').textContent=m?`${(m.threshold*100).toFixed(1)}%`:'—';
  $x('ml-samples').textContent=m?`${m.holdout.samples.toLocaleString()}`:'—';
  $x('ml-training-note').textContent=m
    ?`Historical data: ${m.coverage.from.slice(0,10)} to ${m.coverage.through.slice(0,10)}. Model trained on verified Binance Vision hourly archives. Results are historical simulations, not a proven trading advantage. ${m.holdout.accepted?'The fifth virtual portfolio may paper-trade fresh confirmed hourly breakouts above the model threshold.':'The fifth virtual portfolio is disabled: its untouched holdout did not satisfy the required evidence gates.'}`
    :`No AI score is shown or traded. ${modelError} Run the GitHub Actions historical-training workflow. The four baseline strategies continue as benchmarks.`;
}
async function loadHistoricalModel(){
  try{
    const response=await fetch('./models/latest.json',{cache:'no-store'});
    if(!response.ok)throw new Error(`No published historical model (HTTP ${response.status}).`);
    const model=await response.json();
    if(!validateModel(model))throw new Error('Published model schema or provenance invalid.');
    historicalModel=model;modelError='';
    for(const [symbol,cache] of candles){const a=scores.get(symbol);if(a)applyMl(symbol,cache.data,a);}
  }catch(error){historicalModel=null;modelError=error.message;}
  renderModelStatus();
}
function applyMl(symbol,bars,analysis){
  if(!analysis)return analysis;
  // Inference and training features use precisely the same 1h closed-bar history.
  const btcbars=candles.get('BTCUSDT')?.data;
  const features=historicalModel?mlFeatures(bars,btcbars):null;
  const p=historicalModel&&features?probability(historicalModel,features):null;
  analysis.mlProbability=p;
  if(analysis.trigger)analysis.trigger.ml=!!(analysis.breakout && modelAllowsPaper(historicalModel,p));
  return analysis;
}
const mlBadge=a=>Number.isFinite(a?.mlProbability)?`<span class="ml-estimate" title="Experimental chance of hitting target before stop from historical hourly simulation. Not a guaranteed win probability.">HISTORICAL ML ${(100*a.mlProbability).toFixed(1)}%</span>`:'<span class="ml-estimate-muted">ML NOT AVAILABLE</span>';
function selection(){
  const topVolume=[...markets].sort((a,b)=>b.volume-a.volume).slice(0,48);
  const momentum=[...markets].filter(x=>x.change>0).sort((a,b)=>b.change-a.change).slice(0,50);
  const activity=[...markets].sort((a,b)=>Math.abs(b.change)*Math.log10(b.volume)-Math.abs(a.change)*Math.log10(a.volume)).slice(0,30);
  return [...new Set([...topVolume,...momentum,...activity,...markets].map(x=>x.symbol))]; // Analyse every monitored pair, not merely the early momentum sample.
}
async function loadBars(symbol,force=false){
  const cached=candles.get(symbol);
  // An unchanged completed 1h candle should not require another API call every minute.
  // Reload at the next hourly close, or if data is missing/too old.
  if(cached&&!force&&hourlyCacheCurrent(cached.data))return cached.data;
  const raw=await json(`klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=95`);
  const bars=parseKlines(raw);
  if(bars.length<55)throw new Error('Insufficient closed hourly candles for '+symbol);
  candles.set(symbol,{when:Date.now(),data:bars});
  const btc=candles.get('BTCUSDT')?.data;
  const btcRet=btc?.length>=25?(btc.at(-1).close/btc.at(-25).close-1)*100:0;
  const a=analyse(bars,btcRet);if(a)scores.set(symbol,applyMl(symbol,bars,a));
  return bars;
}
async function pool(items,n,handler){let index=0,errors=0;async function work(){while(index<items.length){const i=index++;try{await handler(items[i],i);}catch(e){errors++;if(errors<5)console.warn('Market series unavailable',items[i],e.message);}}}await Promise.all(Array.from({length:n},work));return errors;}
function triggers(a){return a?STRATEGIES.filter(s=>a.trigger[s.id]):[];}
const stageLabel=a=>a?.stage==='approaching'?'APPROACHING':a?.stage==='confirmed'?'BREAKOUT':a?.stage==='watch'?'ON RADAR':a?'OTHER':'UNSCANNED';
function stageWeight(a){return a?.stage==='approaching'?0:a?.stage==='confirmed'?1:a?.stage==='watch'?2:a?3:4;}
const meter=(label,value,valueText)=>`<div class="indicator-meter"><div class="meter-header"><span>${escape(label)}</span><b>${escape(valueText)}</b></div><div class="meter-track"><div class="meter-fill" style="width:${Math.max(0,Math.min(100,Number(value)||0)).toFixed(1)}%"></div></div></div>`;
function compactMeters(a){if(!a)return `<div class="unscanned-note">Hourly indicators pending — not ranked yet</div>`;
  return `<div class="card-indicators">${meter('TO RESISTANCE',a.proximity,a.distancePct<=0?'Above':num(a.distancePct,2)+'% below')}${meter('RSI 14',a.rsiMeter??0,Number.isFinite(a.technical.rsi14)?num(a.technical.rsi14,1):'—')}${meter('VOLUME / AVG',a.volumeMeter,num(a.volumeRatio,2)+'×')}</div>`;
}
function orderPairs(){const sort=$('sort').value,find=$('filter').value.trim().toUpperCase();let arr=markets.filter(m=>m.symbol.includes(find));arr.sort((a,b)=>{
  if(sort==='gain')return b.change-a.change;
  if(sort==='volume')return b.volume-a.volume;
  if(sort==='alphabetical')return a.symbol.localeCompare(b.symbol);
  const x=scores.get(a.symbol),y=scores.get(b.symbol);
  if(sort==='ml'){const xd=x?.mlProbability,yd=y?.mlProbability;return (Number.isFinite(yd)?yd:-1)-(Number.isFinite(xd)?xd:-1)||b.volume-a.volume;}
   if(sort==='distance'){const xd=x?.distancePct>0?x.distancePct:Infinity,yd=y?.distancePct>0?y.distancePct:Infinity;return xd-yd||b.volume-a.volume;}
  return stageWeight(x)-stageWeight(y)||((y?.stage==='confirmed'?y?.score:y?.readinessScore)??-1)-((x?.stage==='confirmed'?x?.score:x?.readinessScore)??-1)||b.volume-a.volume;
});return arr;}
function cardHTML(m){const a=scores.get(m.symbol),sc=a?String(a.stage==='confirmed'?a.score:a.readinessScore):'—';return `<article class="coin-card ${a?.stage==='approaching'?'near-signal-card':a?.stage==='confirmed'?'confirmed-signal-card':''}" data-symbol="${escape(m.symbol)}" tabindex="0" role="button" aria-label="Open ${escape(m.symbol)} analysis"><div class="card-top"><div><div class="symbol">${escape(quote(m.symbol))}<span class="pair-quote">/USDT</span></div><div class="small-muted">24H ${pct(m.change)}</div></div><div><div class="score">${sc}</div><span class="score-label">${a?.stage==='confirmed'?'BREAKOUT':'READINESS'} /100</span></div></div><div class="card-stage ${a?.stage||'unscanned'}">${stageLabel(a)}</div><canvas width="560" height="210" aria-label="${escape(CHART_LABELS[chartInterval])} candle chart for ${escape(m.symbol)}"></canvas>${compactMeters(a)}${mlBadge(a)}<div class="card-bottom"><span>${a?triggers(a).length+' triggered models':'UNSCANNED'}</span><span class="${m.change>=0?'up':'down'}">VOL ${m.volume>=1e6?num(m.volume/1e6,1)+'M':num(m.volume/1e3,0)+'K'} USDT</span></div></article>`;}
function renderCards(){
  if(observer)observer.disconnect();visibleSymbols.clear();
  const cards=$('cards'),arr=orderPairs();cards.innerHTML=arr.length?arr.map(cardHTML).join(''):'<div class="empty">No matching trading pairs.</div>';
  const requestedInterval=chartInterval;
  observer=new IntersectionObserver(entries=>{for(const e of entries){
    const node=e.target,symbol=node.dataset.symbol;
    if(!e.isIntersecting){visibleSymbols.delete(symbol);continue;}
    visibleSymbols.add(symbol);
    if(node.querySelector('canvas').dataset.interval===requestedInterval)continue;
    loadDisplayBars(symbol,requestedInterval).then(bars=>drawCard(node,symbol,requestedInterval,bars)).catch(()=>{
      if(node.isConnected&&chartInterval===requestedInterval)drawChartError(node.querySelector('canvas'),'Chart unavailable');
    });
  }},{rootMargin:'120px'});
  cards.querySelectorAll('.coin-card').forEach(node=>{observer.observe(node);node.addEventListener('click',()=>detail(node.dataset.symbol));node.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();detail(node.dataset.symbol);}});});
}
const shortInterval=interval=>['1m','3m','5m'].includes(interval);
async function refreshVisibleCharts(force=false){
  if(chartRefreshBusy||document.hidden||!shortInterval(chartInterval)&&($('detail').hidden||!shortInterval(detailInterval)))return;
  chartRefreshBusy=true;const interval=chartInterval,targets=(force||shortInterval(interval))?[...visibleSymbols].slice(0,24):[];
  let updated=0,errors=0;
  try{
    await pool(targets,4,async symbol=>{try{const bars=await loadDisplayBars(symbol,interval,true);const node=[...$('cards').querySelectorAll('.coin-card')].find(el=>el.dataset.symbol===symbol);if(node&&node.isConnected&&chartInterval===interval){drawCard(node,symbol,interval,bars);updated++;}}catch(err){errors++;console.warn('Chart refresh failed',symbol,err.message);}});
    if(!$('detail').hidden&&detailSymbol&&shortInterval(detailInterval))await updateDetail(true);
    if(shortInterval(interval)||force){
      if(updated)shortRefreshAt=Date.now();
      $('chart-refresh-state').textContent=`${updated} visible ${CHART_LABELS[interval]} charts refreshed ${new Date().toISOString().slice(11,19)} UTC${errors?' · '+errors+' unavailable':''}.`;
    }
  }finally{chartRefreshBusy=false;}
}
function drawCandles(canvas,bars,resistance=null,overlays=false,trade=null){
  const context=canvas.getContext('2d');if(!context||!bars?.length)return;
  const W=canvas.width,H=canvas.height;context.clearRect(0,0,W,H);
  const data=bars.slice(trade?-180:-48);
  const levels=trade?tradeLevels(trade,paper.config):null;
  const prices=[...data.map(c=>c.low),...data.map(c=>c.high)];
  if(levels)prices.push(levels.entry,levels.stopTrigger,levels.targetTrigger,...(levels.exit?[levels.exit]:[]));
  const minPrice=Math.min(...prices),maxPrice=Math.max(...prices),padding=Math.max((maxPrice-minPrice)*.06,minPrice*.0001);
  const low=minPrice-padding,high=maxPrice+padding,span=Math.max(high-low,low*.00001);
  const top=H*.07,bottom=H*.77,left=10,right=W-10;
  const yy=p=>bottom-(p-low)/span*(bottom-top),step=(right-left)/data.length;
  context.strokeStyle='#343434';context.lineWidth=1;for(let i=0;i<4;i++){const y=top+(bottom-top)*i/3;context.beginPath();context.moveTo(left,y);context.lineTo(right,y);context.stroke();}
  if(Number.isFinite(resistance)&&resistance>=low&&resistance<=high){context.setLineDash([9,7]);context.strokeStyle='#929292';context.beginPath();context.moveTo(left,yy(resistance));context.lineTo(right,yy(resistance));context.stroke();context.setLineDash([]);}
  const vm=Math.max(1,...data.map(c=>c.volume));
  data.forEach((c,i)=>{const x=left+step*(i+.5),up=c.close>=c.open,color=up?'#d5d5d5':'#777777';context.strokeStyle=color;context.fillStyle=color;context.lineWidth=Math.max(1.5,step*.17);context.beginPath();context.moveTo(x,yy(c.high));context.lineTo(x,yy(c.low));context.stroke();const ya=yy(Math.max(c.open,c.close)),yb=yy(Math.min(c.open,c.close));context.fillRect(x-step*.27,ya,Math.max(2,step*.54),Math.max(2,yb-ya));context.globalAlpha=.3;context.fillRect(x-step*.27,H*.98-(c.volume/vm)*H*.15,Math.max(2,step*.54),(c.volume/vm)*H*.15);context.globalAlpha=1;});
  // EMA overlays on the expanded chart; values computed from full series to avoid warm-up bias.
  if(overlays){const series=[{values:emaSeries(bars.map(c=>c.close),9),color:'#d0d0d0'},{values:emaSeries(bars.map(c=>c.close),21),color:'#777777'}];
    for(const line of series){context.strokeStyle=line.color;context.lineWidth=2;context.beginPath();let started=false;const offset=bars.length-data.length;
      for(let i=0;i<data.length;i++){const v=line.values[offset+i];if(!Number.isFinite(v)){started=false;continue;}const x=left+step*(i+.5);if(!started){context.moveTo(x,yy(v));started=true;}else context.lineTo(x,yy(v));}context.stroke();}
  }
  if(levels){
    // Draw reference levels even if the matching event timestamp lies outside this window;
    // an entry/sell marker is drawn ONLY when the genuine minute candle contains its timestamp.
    const isOpen=levels.exitTime===null;
    const horizontals=[
      {price:levels.entry,label:'ENTRY FILL',color:isOpen?'#f06878':'#cecece',dash:[]},
      {price:levels.stopTrigger,label:'STOP TRIGGER',color:'#a5a5a5',dash:[8,5]},
      {price:levels.targetTrigger,label:'SELL TARGET',color:'#858585',dash:[8,5]},
    ];
    if(levels.exit!==null&&levels.exitTime!==null)horizontals.push({price:levels.exit,label:'ACTUAL SIM SELL',color:'#e0e0e0',dash:[3,4]});
    horizontals.forEach(({price,label,color,dash},i)=>{
      context.setLineDash(dash);context.strokeStyle=color;context.lineWidth=1.6;
      context.beginPath();context.moveTo(left,yy(price));context.lineTo(right,yy(price));context.stroke();context.setLineDash([]);
      context.font='bold 11px monospace';const width=context.measureText(label).width+13;
      context.fillStyle='#101010dc';context.fillRect(right-width-1,yy(price)-13,width+4,15);
      context.font='bold 11px monospace';context.fillStyle=color;context.fillText(label,right-width+4,yy(price)-2);
    });
    const markers=[{time:levels.entryTime,price:levels.entry,label:'BUY',color:isOpen?'#f06878':'#cecece'}];
    if(levels.exitTime!==null&&levels.exit!==null)markers.push({time:levels.exitTime,price:levels.exit,label:'SELL',color:'#e0e0e0'});
    const drawn=[];
    markers.forEach(({time,price,label,color})=>{
      const x=minuteMarkerPosition(data,time,left,right);
      if(x===null)return;
      const y=yy(price);context.setLineDash([4,5]);context.strokeStyle=color;context.lineWidth=1.25;
      context.beginPath();context.moveTo(x,top);context.lineTo(x,bottom);context.stroke();context.setLineDash([]);
      context.beginPath();context.arc(x,y,6,0,Math.PI*2);context.fillStyle=color;context.fill();
      context.strokeStyle='#080808';context.lineWidth=2;context.stroke();
      const labelX=Math.min(right-42,Math.max(left+4,x+9));context.font='bold 12px monospace';context.fillStyle=color;context.fillText(label,labelX,Math.max(top+13,y-11));
      drawn.push(label.toLowerCase());
    });
    canvas.dataset.tradeMarkers=drawn.join(',');
    canvas.dataset.tradeEntry=String(levels.entryTime);
    canvas.dataset.tradeStatus=levels.exitTime===null?'open':'closed';
  }else{delete canvas.dataset.tradeMarkers;delete canvas.dataset.tradeEntry;delete canvas.dataset.tradeStatus;}
}
function drawCard(node,symbol,interval,bars){if(!node.isConnected||chartInterval!==interval)return;const canvas=node.querySelector('canvas');drawCandles(canvas,bars,interval==='1h'?scores.get(symbol)?.resistance:null);canvas.dataset.interval=interval;
  const score=scores.get(symbol);if(score){node.querySelector('.score').textContent=score.stage==='confirmed'?score.score:score.readinessScore;node.querySelector('.card-bottom span').textContent=triggers(score).length+' triggered models';}}
function renderApproaching(){
  const confirmed=markets.filter(m=>triggers(scores.get(m.symbol)).length).sort((a,b)=>(scores.get(b.symbol).score-scores.get(a.symbol).score));
  const near=markets.filter(m=>scores.get(m.symbol)?.stage==='approaching').sort((a,b)=>scores.get(b.symbol).readinessScore-scores.get(a.symbol).readinessScore);
  const merged=[...confirmed.slice(0,8).map(m=>({kind:'confirmed',m,a:scores.get(m.symbol)})),...near.slice(0,8).map(m=>({kind:'approaching',m,a:scores.get(m.symbol)}))];
  $('metric-near').textContent=near.length;$('near-count').textContent=near.length+confirmed.length;
  $('approaching').innerHTML=merged.length?merged.map(({kind,m,a})=>{
    if(kind==='confirmed')return `<div class="signal-tile breakout-tile" data-symbol="${escape(m.symbol)}" tabindex="0" role="button"><div class="tile-top"><div><div class="symbol">${escape(quote(m.symbol))}<span class="pair-quote">/USDT</span></div><div class="small-muted">24H ${pct(m.change)} · confirmed hourly breakout</div></div><div><div class="score">${a.score}</div><div class="score-label">BREAKOUT /100</div></div></div><div class="tile-details">Relative strength vs BTC: ${pct(a.relative)}<br>Volume / 20h avg: ${num(a.volumeRatio,1)}× · Models: ${triggers(a).length}<br>${mlBadge(a)}</div><div class="mini-progress breakout-progress"><span style="width:100%"></span></div><span class="tile-label breakout-label">CONFIRMED BREAKOUT · ENTRY SIGNAL · ${escape(triggers(a).map(s=>s.name).join(' · '))}</span></div>`;
    return `<div class="signal-tile near-tile" data-symbol="${escape(m.symbol)}" tabindex="0" role="button"><div class="tile-top"><div><div class="symbol">${escape(quote(m.symbol))}<span class="pair-quote">/USDT</span></div><div class="small-muted">${num(a.distancePct,2)}% below 24h resistance</div></div><div><div class="score">${a.readinessScore}</div><div class="score-label">READINESS /100</div></div></div><div class="tile-details">RSI(14): ${num(a.technical.rsi14,1)} · Volume: ${num(a.volumeRatio,2)}×<br>Relative to BTC: ${pct(a.relative)} · Trend: ${a.trend?'bullish':'unconfirmed'}<br>${mlBadge(a)}</div><div class="mini-progress"><span style="width:${a.proximity.toFixed(1)}%"></span></div><span class="tile-label">APPROACHING · NO ENTRY SIGNAL</span></div>`;
  }).join(''):'<div class="empty">No liquid analysed pairs currently meet the breakout-radar criteria. No prediction is implied.</div>';
  $('approaching').querySelectorAll('[data-symbol]').forEach(n=>{n.addEventListener('click',()=>detail(n.dataset.symbol));n.addEventListener('keydown',e=>{if(e.key==='Enter')detail(n.dataset.symbol);});});
}
function renderSignals(){const matches=markets.filter(x=>triggers(scores.get(x.symbol)).length).sort((a,b)=>(scores.get(b.symbol).score-scores.get(a.symbol).score));$('metric-signals').textContent=matches.length;
  const target=$('signals');if(!target)return;
  target.innerHTML=matches.length?'<div class="empty">Confirmed breakouts are now pinned at the front of the breakout radar above and outlined in red.</div>':'<div class="empty">No confirmed breakout triggers among analysed pairs. This is a valid no-trade result.</div>';
}
async function detail(symbol,preferredTradeKey=null){
  if(detailSymbol!==symbol)selectedTradeKey=null;
  detailSymbol=symbol;if(preferredTradeKey)selectedTradeKey=preferredTradeKey;
  $('detail').hidden=false;$('detail-symbol').textContent=symbol;
  // A recorded paper trade opens at 1m by default to show its actual minute timestamp.
  detailInterval=preferredTradeKey||recordedTrades(paper,symbol).length?'1m':chartInterval;
  tradeWindow='entry';selectInterval('detail-timeframes',detailInterval);
  await updateDetail();
}
async function updateDetail(force=false){
  if(!detailSymbol||$('detail').hidden)return;
  const symbol=detailSymbol,interval=detailInterval,requestId=++detailRequest,canvas=$('detail-chart');
  const trade=renderTradeControls();
  $('detail-timeframe-label').textContent=`PAIR DETAIL / ${interval==='1M'?'1M':interval.toUpperCase()} CHART`;
  $('detail-stats').textContent=`Loading ${CHART_LABELS[interval]} candles…`;
  $('detail-indicators').textContent='Loading indicator calculations…';
  $('detail-explanation').textContent='';canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
  try{
    const bars=interval==='1m'&&trade&&tradeWindow!=='latest'?await loadTradeMinuteBars(symbol,trade,tradeWindow,force):await loadDisplayBars(symbol,interval,force);
    if(requestId!==detailRequest||$('detail').hidden)return;
    const a=scores.get(symbol),m=bySymbol.get(symbol),tech=indicators(bars),bb=tech.bollinger;
    drawCandles(canvas,bars,interval==='1h'?a?.resistance:null,true,interval==='1m'?trade:null);canvas.dataset.interval=interval;
    canvas.dataset.lastUpdate=String(Date.now());
    $('detail-chart-note').textContent=interval==='1m'&&trade?`Showing ${tradeWindow==='entry'?'entry':tradeWindow==='exit'?'exit':'latest'} minute window · ${timeUTC(bars[0].time)} to ${timeUTC(bars.at(-1).closeTime)}. Lines are simulated trigger/fill levels; markers use stored paper-trade timestamps. Candles do not prove tick-accurate execution.`:'Trade markers appear on 1m charts only when a paper trade has actually been recorded.';
    $('detail-stats').innerHTML=`<span>CHART <b>${escape(CHART_LABELS[interval])} candles</b></span><span>AVAILABLE <b>${bars.length} bars</b></span><span>LAST CHART CLOSE <b>${num(bars.at(-1)?.close,6)}</b> USDT</span><span>24H MARKET <b>${pct(m?.change)}</b></span><span>1H RESISTANCE <b>${num(a?.resistance,6)}</b></span><span>RESISTANCE DISTANCE <b>${a?num(a.distancePct,2)+'%':'—'}</b></span>`;
    const items=[['RSI (14)',num(tech.rsi14,1)],['MACD HIST',num(tech.macd.histogram,6)],['EMA (9)',num(tech.ema9,6)],['EMA (21)',num(tech.ema21,6)],['EMA (50)',num(tech.ema50,6)],['BB WIDTH (20,2)',num(bb.widthPct,2)+'%'],['ATR (14)',num(tech.atrPct,2)+'%'],['1H VOLUME / AVG',a?num(a.volumeRatio,2)+'×':'—'],['1H VS BTC',a?pct(a.relative):'—'],['1H READINESS',a?String(a.readinessScore)+'/100':'—']];
    $('detail-indicators').innerHTML=items.map(([label,value])=>`<div class="detail-indicator"><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`).join('');
    $('detail-explanation').innerHTML=a?`<strong>Hourly classification:</strong> ${escape(stageLabel(a))} · ${num(a.distancePct,2)}% below resistance (negative means above). <strong>Readiness:</strong> ${a.readinessScore}/100 (heuristic, not a probability).<br><strong>Historical ML estimate:</strong> ${Number.isFinite(a.mlProbability)?(100*a.mlProbability).toFixed(1)+'% target-first estimate; experimentally trained on historical data':'NO TRAINED MODEL'}<br><strong>Hourly paper-entry triggers:</strong> ${triggers(a).length?triggers(a).map(s=>escape(s.name)).join(', '):'None'} · <strong>Trend:</strong> ${a.trend?'bullish':'not confirmed'}. <strong>Compression:</strong> ${a.compression?'detected':'not detected'}.<br><strong>Overlay:</strong> <span class="ema9-legend">EMA 9</span> and <span class="ema21-legend">EMA 21</span>. RSI, MACD, EMA, Bollinger Bands and ATR are calculated from the selected chart interval, which may include a forming candle; screening and all paper trades still use closed 1H candles.`:'This pair has no completed hourly assessment. The chart indicators are informational, and may include the forming candle.';
  }catch(e){if(requestId===detailRequest&&!$('detail').hidden){$('detail-stats').textContent='Market candles unavailable: '+e.message;$('detail-indicators').textContent='No valid indicator data';drawChartError(canvas,'Chart unavailable');}}
}
function syncOpenTradeHighlights(){
  const held=new Set(STRATEGIES.flatMap(s=>paper.portfolios[s.id].positions.map(p=>p.symbol)));
  document.querySelectorAll('.signal-tile[data-symbol],.coin-card[data-symbol],.trade-ledger-row[data-symbol]').forEach(el=>{
    const active=held.has(el.dataset.symbol);
    el.classList.toggle('live-position',active);
    if(active)el.setAttribute('data-open-paper','true');else el.removeAttribute('data-open-paper');
  });
}
function paperUI(){const n=$('paper-notice');n.classList.toggle('active',armed);n.textContent=armed?'ARMED · Virtual long trades may open after a fresh, confirmed hourly signal. Scanning and exits only work while this browser tab is running.':'PAUSED · No new positions will open. The simulator runs only while this page is open. Existing paper positions are checked when market data are available.';$('paper-toggle').textContent=armed?'Pause new trades':'Start paper engine';
  $('portfolios').innerHTML=STRATEGIES.map(s=>{const p=paper.portfolios[s.id],st=portfolioStats(p,Object.fromEntries(markets.map(m=>[m.symbol,m.price])),paper.config);return `<div class="portfolio"><h3>${escape(s.name)}</h3><div class="fine">STARTED $${num(paper.config.startingCash,0)} · ${st.openCount} OPEN</div><div class="net ${st.realised>0?'pos':st.realised<0?'neg':''}">${cash(st.realised)}</div><div class="fine">REALIZED NET P&amp;L<br>${st.trades} CLOSED TRADES · WIN RATE ${st.winRate===null?'—':num(st.winRate,1)+'%'}<br>EST. EQUITY ${cash(st.estimatedEquity)}</div></div>`;}).join('');
  const pnl=paperPerformance(paper,Object.fromEntries(markets.map(m=>[m.symbol,m.price])));
  $('paper-total-net').textContent=pnl.estimatedNet===null?'—':cash(pnl.estimatedNet);
  $('paper-total-realised').textContent=cash(pnl.realised);
  $('paper-total-open').textContent=pnl.openEstimate===null?'—':cash(pnl.openEstimate);
  $('paper-summary-caption').textContent=pnl.missingMarks?`${pnl.missingMarks} open position(s) lack a current Binance price. Estimated total unavailable; realised profit remains exact within the simulator.`:`${pnl.openCount} open positions · ${pnl.closedCount} closed positions · ${cash(pnl.initial)} initial virtual capital across ${STRATEGIES.length} independent model accounts. Open P&L uses latest available spot prices and estimated exit fees/slippage.`;
  $('header-paper-pnl').textContent=`PAPER NET ${pnl.estimatedNet===null?'—':cash(pnl.estimatedNet)}`;
  const raw=STRATEGIES.flatMap(s=>{const p=paper.portfolios[s.id];return [...p.trades,...p.positions];});
  const events=groupPaperEvents(raw).slice(0,100);
  $('ledger').innerHTML=events.length?events.map(g=>{
    const nameList=g.strategyIds.map(id=>STRATEGIES.find(s=>s.id===id)?.name||id).join(' · ');
    const plurality=g.trades.length===1?'model':'models';
    const pnlLabel=g.realisedPnl===null?'—':cash(g.realisedPnl);
    const details=g.closedCount?`${g.closedCount} closed${g.openCount?' · '+g.openCount+' open':''}`:`${g.openCount} open`;
    return `<tr class="trade-ledger-row" data-symbol="${escape(g.symbol)}" data-trade="${escape(tradeKey(g.representative))}" tabindex="0" aria-label="View ${escape(g.symbol)} paper positions across ${g.trades.length} ${plurality} on minute chart"><td>${new Date(g.entryTime).toISOString().slice(0,16).replace('T',' ')}</td><td><strong class="bundle-count">${g.trades.length} ${plurality}</strong><span class="bundle-detail">${escape(nameList)}</span></td><td>${escape(g.symbol)}</td><td>${g.entryPrice===null?'VARIES':num(g.entryPrice,6)}</td><td>${g.exitPrice===null?'—':num(g.exitPrice,6)}</td><td class="${g.realisedPnl===null?'':g.realisedPnl>=0?'profit':'loss'}">${pnlLabel}<span class="bundle-detail">${g.closedCount?`across ${g.closedCount} virtual portfolios`:''}</span></td><td>${escape(g.status)}<span class="bundle-detail">${escape(details)}</span></td></tr>`;
  }).join(''):'<tr><td colspan="7">No trades yet. A blank ledger is not a profitable result.</td></tr>';
  syncOpenTradeHighlights();
}
async function bookAsk(symbol){const d=await json(`ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`);const ask=+d.askPrice,bid=+d.bidPrice;return Number.isFinite(ask)&&Number.isFinite(bid)&&ask>0&&bid>0&&ask>=bid?ask:null;}
async function managePositions(){const positions=STRATEGIES.flatMap(s=>paper.portfolios[s.id].positions);if(!positions.length)return;
  const grouped=new Map();for(const p of positions){if(!grouped.has(p.symbol))grouped.set(p.symbol,[]);grouped.get(p.symbol).push(p);}
  for(const [symbol,items] of grouped){try{const oldest=Math.min(...items.map(p=>p.lastChecked)),now=Date.now();if(now-oldest>950*60000){items.forEach(p=>p.dataGap=true);continue;}
    const raw=await json(`klines?symbol=${encodeURIComponent(symbol)}&interval=1m&startTime=${Math.max(0,oldest-60000)}&limit=1000`);
    const bars=parseKlines(raw,now);if(!bars.length)continue;
    for(const p of items){const eligible=bars.filter(c=>c.time>=Math.max(p.entryTime,p.lastChecked));const exit=evaluateExit(p,eligible,now,paper.config);if(exit)closePaper(paper,p.strategyId,symbol,exit.market,exit.reason,exit.at);else p.lastChecked=bars.at(-1).closeTime+1;}
  }catch(e){console.warn('Paper exit data unavailable',symbol,e.message);showError('Could not verify open paper positions for '+symbol+'. No exit has been invented.');}}
  save();paperUI();
}
async function enterSignals(){if(!armed)return;const now=Date.now();const active=markets.filter(m=>{const a=scores.get(m.symbol);return a&&now-a.lastBarTime>=0&&now-a.lastBarTime<15*60000&&triggers(a).length;});
  const picked=active.sort((a,b)=>scores.get(b.symbol).score-scores.get(a.symbol).score).slice(0,16);
  for(const m of picked){const a=scores.get(m.symbol);let ask;try{ask=await bookAsk(m.symbol);}catch(e){console.warn('No executable ask quote',m.symbol,e.message);continue;}if(!ask)continue;
    for(const s of triggers(a))openPaper(paper,s.id,m.symbol,ask,a.lastBarTime,Date.now());
  }save();paperUI();
}
async function scan(){if(busy)return;busy=true;clearError();$('refresh').disabled=true;
  try{status('Refreshing Binance spot market universe…');await universe();ready=true;setLive();
    // BTC is explicitly refreshed first to avoid an undefined relative-strength benchmark.
    try{await loadBars('BTCUSDT');}catch(e){throw new Error('BTC benchmark unavailable: '+e.message);}
    status('Updating live prices and checking closed 1h indicators…');const selected=selection();let done=0;
    const errors=await pool(selected,5,async sym=>{try{await loadBars(sym);}finally{done++;if(done%25===0||done===selected.length)status(`Checked ${done}/${selected.length} pairs`);}});
    // Re-rank all pairs every minute from FRESH last-traded prices, with indicators and
    // ENTRY signals remaining tied to the latest COMPLETED hourly candle.
    for(const m of markets){const a=scores.get(m.symbol);if(a)scores.set(m.symbol,withLiveReadiness(a,m.price));}
    scannedAt=Date.now();const analysed=markets.filter(m=>scores.has(m.symbol)).length;
    $('metric-scanned').textContent=analysed;$('metric-time').textContent=new Date(scannedAt).toISOString().slice(11,19);
    renderCards();renderApproaching();renderSignals();await managePositions();await enterSignals();paperUI();status(`Scan complete · ${analysed}/${markets.length} analysed · ${errors} unavailable · live rankings ~1 min · signals 1h`);
    if(errors)showError(`${errors} symbols could not be analysed. Missing series were excluded, not estimated.`);
  }catch(e){status('Scan failed · no invented data');showError(e.message);}finally{busy=false;$('refresh').disabled=false;}
}
function downloadCSV(){const all=STRATEGIES.flatMap(s=>paper.portfolios[s.id].trades);const header=['strategy','symbol','entry_time_utc','exit_time_utc','entry_fill','exit_fill','cost_usdt','proceeds_usdt','entry_fee_usdt','exit_fee_usdt','net_pnl_usdt','return_pct','reason'];const lines=all.map(t=>[t.strategyId,t.symbol,new Date(t.entryTime).toISOString(),new Date(t.exitTime).toISOString(),t.entryPrice,t.exitPrice,t.cost,t.proceeds,t.entryFee,t.exitFee,t.pnl,t.returnPct,t.reason].join(','));const b=new Blob([[header.join(','),...lines].join('\n')],{type:'text/csv'});const url=URL.createObjectURL(b);const a=document.createElement('a');a.href=url;a.download='breakout-lab-paper-trades.csv';a.click();URL.revokeObjectURL(url);}

// Cloudflare monitor is READ-ONLY and independently funded/accounted. Nothing here can
// arm cloud trading, reset D1 positions or merge them with local browser portfolios.
let cloudWorkerUrl='';
function cloudStatus(text,status='disconnected'){
  $('cloud-run-state').textContent=status==='connected'?'CONNECTED · PAPER ONLY':status==='stale'?'STALE · CHECK LOGS':'NOT CONNECTED';
  $('cloud-message').textContent=text;
}
function utcBrief(ms){return Number.isFinite(ms)?new Date(ms).toISOString().replace('T',' ').slice(0,16)+' UTC':'—';}
function cloudNumeric(v){return typeof v==='number'&&Number.isFinite(v)?cash(v):'—';}
async function refreshCloud(){
  if(!cloudWorkerUrl){cloudStatus('Enter your deployed Cloudflare Worker URL to read its persistent virtual trading results.');return;}
  try{
    const url=new URL(cloudWorkerUrl);
    if(url.protocol!=='https:')throw new Error('Only HTTPS Worker URLs are supported.');
    const res=await fetch(`${url.origin}${url.pathname.replace(/\/$/,'')}/api/status`,{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!res.ok)throw new Error(`Cloud monitor HTTP ${res.status}`);
    const data=await res.json();
    if(data.paperOnly!==true||data.liveOrders!==false||!data.performance||!data.meta)throw new Error('This endpoint is not a recognised read-only V2 cloud monitor.');
    const last=Date.parse(data.meta.lastSuccess??'');
    const stale=!Number.isFinite(last)||Date.now()-last>25*60000;
    cloudStatus(stale?'No recent successful server scan. Check the Worker Cron Trigger and logs.':`Independent virtual account · ${data.universe} symbols in a ~${data.rotationMinutes}-minute rotation · ML: ${data.meta.modelStatus}. ${data.meta.missing?.length??0} latest data warnings.`,stale?'stale':'connected');
    $('cloud-total').textContent=cloudNumeric(data.performance.estimatedNet);
    $('cloud-realised').textContent=cloudNumeric(data.performance.realised);
    $('cloud-open').textContent=Number.isInteger(data.performance.openCount)?String(data.performance.openCount):'—';
    $('cloud-last-run').textContent=Number.isFinite(last)?utcBrief(last):'—';
    const trades=Array.isArray(data.trades)?data.trades.slice(0,60):[];
    $('cloud-trades').innerHTML=trades.length?trades.map(t=>`<tr><td>${utcBrief(Number(t.exitTime))}</td><td>${escape(t.strategy)}</td><td>${escape(t.symbol)}</td><td>${num(t.entryPrice,6)}</td><td>${num(t.exitPrice,6)}</td><td>${cloudNumeric(t.pnl)}</td><td>${escape(t.reason)}</td></tr>`).join(''):'<tr><td colspan="7">No completed cloud paper trades recorded yet.</td></tr>';
  }catch(e){cloudStatus('Cloud monitor unavailable: '+e.message,'disconnected');}
}

function init(){
  const savedWorker=localStorage.getItem('breakout-v2-cloud-worker-url');
  if(savedWorker){cloudWorkerUrl=savedWorker;$('cloud-worker-url').value=savedWorker;refreshCloud();}
  $('cloud-connect').addEventListener('click',()=>{cloudWorkerUrl=$('cloud-worker-url').value.trim().replace(/\/$/,'');localStorage.setItem('breakout-v2-cloud-worker-url',cloudWorkerUrl);refreshCloud();});
  setInterval(()=>{if(!document.hidden&&cloudWorkerUrl)refreshCloud();},60000);
  $('methods').innerHTML=STRATEGIES.map((s,i)=>`<div class="method-card"><div class="ordinal">MODEL 0${i+1}</div><h3>${escape(s.name)}</h3><p>${escape(s.description)} Requires a closed hourly breakout candle; the additional filters vary by model. Every model begins with its own $10,000 simulated cash balance.</p></div>`).join('');
  $('refresh').addEventListener('click',scan);$('refresh-charts').addEventListener('click',()=>refreshVisibleCharts(true));$('filter').addEventListener('input',renderCards);$('sort').addEventListener('change',renderCards);
  selectInterval('chart-timeframes',chartInterval);selectInterval('detail-timeframes',chartInterval);
  $('chart-timeframes').addEventListener('click',e=>{const button=e.target.closest('button[data-interval]');if(!button||!Object.hasOwn(CHART_LABELS,button.dataset.interval))return;
    const chosen=button.dataset.interval;if(chosen===chartInterval)return;chartInterval=chosen;
    try{localStorage.setItem('breakout-v2-chart-interval',chosen);}catch{}
    selectInterval('chart-timeframes',chosen);renderCards();$('chart-refresh-state').textContent=shortInterval(chosen)?'Auto-refresh every ~60 seconds for visible charts while open.':'Live market scan every ~1 minute; entry signals use completed 1H candles.';
    if(!$('detail').hidden){detailInterval=chosen;selectInterval('detail-timeframes',chosen);updateDetail();}
  });
  $('detail-timeframes').addEventListener('click',e=>{const button=e.target.closest('button[data-interval]');if(!button||!Object.hasOwn(CHART_LABELS,button.dataset.interval))return;
    detailInterval=button.dataset.interval;selectInterval('detail-timeframes',detailInterval);updateDetail();
  });
  $('detail-trade-select').addEventListener('change',e=>{selectedTradeKey=e.target.value;tradeWindow='entry';updateDetail();});
  $('detail-trade-windows').addEventListener('click',e=>{const button=e.target.closest('button[data-window]');if(!button||button.disabled)return;tradeWindow=button.dataset.window;updateDetail(true);});
  $('detail-paper-hint').addEventListener('click',()=>{if(detailInterval!=='1m'&&activeTrade()){detailInterval='1m';tradeWindow='entry';selectInterval('detail-timeframes',detailInterval);updateDetail();}});
  $('ledger').addEventListener('click',e=>{const row=e.target.closest('tr[data-trade]');if(row)detail(row.dataset.symbol,row.dataset.trade);});
  $('ledger').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){const row=e.target.closest('tr[data-trade]');if(row){e.preventDefault();detail(row.dataset.symbol,row.dataset.trade);}}});
  $('paper-toggle').addEventListener('click',()=>{armed=!armed;localStorage.setItem('breakout-v2-armed',armed?'yes':'no');paperUI();if(armed&&ready)enterSignals();});
  $('export').addEventListener('click',downloadCSV);$('reset').addEventListener('click',()=>{if(confirm('Erase all five local virtual portfolios and their trade history? This cannot be undone.')){paper=createState();selectedTradeKey=null;save();paperUI();if(!$('detail').hidden)updateDetail();}});
  $('close-detail').addEventListener('click',()=>{$('detail').hidden=true;detailRequest++;});$('detail').querySelector('[data-close]').addEventListener('click',()=>{$('detail').hidden=true;detailRequest++;});document.addEventListener('keydown',e=>{if(e.key==='Escape'){$('detail').hidden=true;detailRequest++;}});
  const clock=()=>{$('clock').textContent=new Date().toISOString().slice(11,19)+' UTC';};clock();setInterval(clock,1000);
  paperUI();renderModelStatus();loadHistoricalModel().then(()=>{scan();});setInterval(()=>{if(!document.hidden)scan();},SCAN_EVERY_MS);setInterval(()=>{if(!document.hidden&&!busy)managePositions();},60000);
  setInterval(()=>{if(!document.hidden)refreshVisibleCharts();},60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){scan();if(shortInterval(chartInterval))refreshVisibleCharts();}});
  $('chart-refresh-state').textContent=shortInterval(chartInterval)?'Visible charts auto-refresh every ~60 seconds while open.':'Live market scan every ~1 minute; entry signals use completed 1H candles.';
}
init();