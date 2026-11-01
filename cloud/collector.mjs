/* GitHub Actions five-minute Binance Spot PAPER collector. No real orders and no keys.
   Trading rules are imported from the same pure engine used by the V2 dashboard.
   The D1 state never goes into git; it is read/written through authenticated endpoints.
*/
import {tick, CLOUD_PAIRS} from './worker.mjs';

export const WORKER_URL = 'https://trade-v2-monitor.kuletski2013.workers.dev';
export const GH_MARKET_HOSTS = Object.freeze(['https://data-api.binance.vision']);

function checkedResponse(r,operation){
  if(!r||!r.ok)throw new Error(`${operation} failed (HTTP ${r?.status??'network'})`);
  return r;
}
export async function collectOnce({token,runId,fetcher=fetch,now=Date.now(),workerUrl=WORKER_URL}={}){
  if(typeof token!=='string'||token.length<32||token.length>256)throw Error('Missing TRADE_V2_INGEST_TOKEN GitHub Actions secret (must be >=32 chars)');
  if(!/^[0-9]{4,24}-[1-9][0-9]{0,4}$/.test(runId||''))throw Error('Invalid GitHub Actions run identity');
  const base=workerUrl.replace(/\/$/,'');
  const headers={Authorization:`Bearer ${token}`,Accept:'application/json'};
  const read=checkedResponse(await fetcher(`${base}/api/state`,{headers,signal:AbortSignal.timeout(15000)}),'Authenticated D1 state read');
  const snapshot=await read.json();
  if(!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0||!snapshot.state?.paper?.portfolios)throw Error('Unrecognized D1 paper state');
  if(snapshot.state.meta?.lastGitHubRunId===runId)return {duplicate:true,revision:snapshot.revision};
  const binanceFetch=(url,init={})=>fetcher(url,{...init,signal:AbortSignal.timeout(15000)});
  const next=await tick(snapshot.state,now,binanceFetch,{allPairs:true,marketHosts:GH_MARKET_HOSTS});
  if(next.meta.lastScanCount<1)throw Error('No valid Binance market data; refusing to commit an empty scan');
  if(next.meta.lastBatch.length!==CLOUD_PAIRS.length)throw Error('Incomplete market universe');
  const write=await fetcher(`${base}/api/commit`,{
    method:'POST',
    headers:{...headers,'Content-Type':'application/json'},
    body:JSON.stringify({baseRevision:snapshot.revision,state:next,runId}),
    signal:AbortSignal.timeout(15000)
  });
  checkedResponse(write,'Authenticated D1 compare-and-swap paper commit');
  const acknowledgement=await write.json();
  if(acknowledgement.status!==200)throw Error('D1 did not confirm authenticated commit');
  return {revision:acknowledgement.revision,at:next.meta.lastSuccess,scanned:next.meta.lastScanCount,
    universe:CLOUD_PAIRS.length,errors:next.meta.missing.length,marketDataHost:next.meta.marketDataHost,
    model:next.meta.modelStatus,duplicate:!!acknowledgement.duplicate};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  const runId=`${process.env.GITHUB_RUN_ID??''}-${process.env.GITHUB_RUN_ATTEMPT??''}`;
  collectOnce({token:process.env.TRADE_V2_INGEST_TOKEN,runId}).then(result=>{
    console.log('Paper research collector completed:',JSON.stringify(result));
  }).catch(error=>{
    console.error('Paper research collector failed:',String(error.message));
    process.exitCode=1;
  });
}