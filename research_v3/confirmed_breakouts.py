#!/usr/bin/env python3
"""Confirmed-breakout-only Binance research, isolated from V2's deployed model.

Data: SHA-256 verified Binance Vision spot hourly archives.  Outcomes: next-hour
open, hourly stop-first resolution, +2% / -1.5%, fees and slippage.

No model produced by this module is live-eligible. The 2025/26 diagnostic period
was previously viewed during V2's research; it is NOT an untouched holdout.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score
from sklearn.preprocessing import StandardScaler

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / 'research'))
import pipeline as original

LOG = logging.getLogger('breakout-confirmed-v3')
HOUR = original.HOUR
HORIZON = original.HORIZON
STRATEGIES = ('breakout', 'volume', 'compression', 'strength')
FEATURES = tuple(f for f in original.FEATURES if f != 'confirmed') + ('breakout_excess_pct',)
PERCENTILE = 70  # Precommitted 30%-selection research comparison; NOT optimised on evaluation results
MAX_POSITIONS = 3
COST_USD = 200
START_CAPITAL_USD = 10000

# Fixed boundaries precommitted before this experiment. 24-hour purge separates
# consecutive partitions and stops forward exit labels leaking across splits.
EDGES = (
    pd.Timestamp('2023-09-01T00:00:00Z').value // 1_000_000,
    pd.Timestamp('2024-09-01T00:00:00Z').value // 1_000_000,
    pd.Timestamp('2025-03-01T00:00:00Z').value // 1_000_000,
    pd.Timestamp('2025-09-01T00:00:00Z').value // 1_000_000,
    pd.Timestamp('2026-10-01T00:00:00Z').value // 1_000_000,
)
SPLITS = ('fit', 'model_selection', 'probability_calibration', 'threshold_calibration', 'reused_diagnostic')


def ema_seeded(close: pd.Series, span: int) -> np.ndarray:
    """Match the JS seeded SMA -> recursive EMA convention, not pandas default."""
    values = close.to_numpy(dtype=float)
    out = np.full(values.shape, np.nan, dtype=float)
    if len(values) < span:
        return out
    out[span-1] = np.mean(values[:span])
    w = 2.0/(span+1)
    for i in range(span,len(values)):
        out[i] = values[i]*w+out[i-1]*(1.0-w)
    return out


def historical_label(df: pd.DataFrame, i: int):
    """Original V2 net-return formula plus verified time-at-exit for portfolio replay."""
    original_label = original.simulate_label(df, i)
    if original_label is None:
        return None
    future = df.iloc[i+1:i+HORIZON+1]
    buy = float(future.iloc[0].open)*(1+original.SLIPPAGE)
    sl = buy*(1-original.STOP)/(1-original.SLIPPAGE)
    tp = buy*(1+original.TARGET)/(1-original.SLIPPAGE)
    exit_i = HORIZON-1
    for j, bar in enumerate(future.itertuples()):
        if bar.low <= sl or bar.high >= tp:
            exit_i = j
            break
    exit_at = int(future.iloc[exit_i].time) + HOUR
    entry_at = int(future.iloc[0].time)
    if exit_at <= entry_at:
        raise AssertionError('Exit cannot precede entry')
    return {**original_label,'entry_at':entry_at,'exit_at':exit_at}


def triggered(df: pd.DataFrame, btc: pd.DataFrame, *, symbol: str) -> pd.DataFrame:
    """Replicate four JS trigger predicates; use only closed-hour features."""
    f = original.features_for_symbol(df,btc)
    if f.empty:
        return pd.DataFrame()
    # Include ALL contiguous confirmed breakouts, even spikes >3% beyond resistance.
    # The original near-resistance dataset excluded those unusually large moves.
    condition = (f['contiguous'].to_numpy(dtype=bool) & (f['confirmed'].to_numpy() > .5) &
                 np.isfinite(f[list(original.FEATURES)]).all(axis=1).to_numpy())
    ix = np.flatnonzero(condition)
    if len(ix)==0:
        return pd.DataFrame()
    closes = df.close
    e9,e21,e50 = (ema_seeded(closes,n) for n in (9,21,50))
    trend = (e9>e21)&(e21>e50)
    result=[]
    for i in ix:
        label = historical_label(df,int(i))
        if label is None:
            continue
        row = f.iloc[i]
        vol = float(row['volume_ratio'])
        rec = {'symbol':symbol,'time':int(df.iloc[i].time),**label}
        rec.update({k:float(row[k]) for k in original.FEATURES if k!='confirmed'})
        prior_res = float(df.high.iloc[int(i)-24:int(i)].max())
        rec['breakout_excess_pct'] = float(np.clip(100*(df.close.iloc[int(i)]/prior_res-1),0,300))
        rec['breakout']=True
        rec['volume']=vol>=1.5
        rec['compression']=vol>=1.2 and float(row['compression_ratio'])<0.8
        rec['strength']=(float(row['relative_24h'])>=3 and bool(trend[i]))
        result.append(rec)
    return pd.DataFrame(result)


def construct_dataset(data: dict[str,pd.DataFrame], trading_symbols: list[str]) -> pd.DataFrame:
    btc = data.get('BTCUSDT')
    if btc is None or len(btc)<85:
        raise ValueError('Verified historical BTCUSDT benchmark not available')
    items=[]
    for sym in trading_symbols:
        df=data.get(sym)
        if df is None or len(df)<85:
            LOG.warning('No historical candle history for %s',sym)
            continue
        events=triggered(df,btc,symbol=sym)
        if not events.empty:
            items.append(events)
            LOG.info('%s confirmed hourly breakouts: %s',sym,len(events))
    if not items:
        raise ValueError('No authentic confirmed breakouts found')
    return pd.concat(items,ignore_index=True).sort_values(['time','symbol']).reset_index(drop=True)


def partition(ds:pd.DataFrame,edges=EDGES):
    times=ds['time'].astype('int64')
    result={}
    # Exclude HORIZON-hour windows immediately before a partition boundary.
    result['fit']=ds[times<edges[0]-HORIZON*HOUR].copy()
    for i,part in enumerate(SPLITS[1:]):
        result[part]=ds[(times>=edges[i]+HORIZON*HOUR)&(times<edges[i+1]-HORIZON*HOUR)].copy()
    result['prospective_unseen']=ds[times>=edges[-1]+HORIZON*HOUR].copy()
    for x,y in zip(SPLITS,SPLITS[1:]):
        a,b=result[x],result[y]
        if not a.empty and not b.empty:
            assert int(a.time.max())+HORIZON*HOUR<int(b.time.min())
    return result


def pick_and_calibrate(parts):
    fit=parts['fit'];choose=parts['model_selection'];cal=parts['probability_calibration']
    for label,df in (('fit',fit),('model selection',choose),('probability calibration',cal)):
        if len(df)<100 or df.won.nunique()<2:
            raise ValueError(f'Insufficient confirmed breakout history in {label}: {len(df)}')
    scaler=StandardScaler().fit(fit[list(FEATURES)])
    xf=scaler.transform(fit[list(FEATURES)]);xs=scaler.transform(choose[list(FEATURES)])
    y=fit.won.to_numpy(dtype=int);ys=choose.won.to_numpy(dtype=int)
    estimators={
        'logistic':LogisticRegression(C=0.1,max_iter=550,random_state=2026),
        'gradient_boosting':GradientBoostingClassifier(n_estimators=85,learning_rate=.045,max_depth=2,
                              min_samples_leaf=70,subsample=.72,random_state=2026)
    }
    options=[]
    for name,clf in estimators.items():
        clf.fit(xf,y)
        yp=clf.predict_proba(xs)[:,1]
        score=float(brier_score_loss(ys,yp))
        options.append((score,name,clf))
    _,name,clf=min(options,key=lambda z:z[0])
    # Fit probability calibration on an independent later slice.
    raw=clf.predict_proba(scaler.transform(cal[list(FEATURES)]))[:,1]
    tiny=np.finfo(float).eps
    logits=np.log(np.clip(raw,tiny,1-tiny)/(1-np.clip(raw,tiny,1-tiny)))
    calibrator=LogisticRegression(C=10,max_iter=400,random_state=2026).fit(logits.reshape(-1,1),cal.won.to_numpy(dtype=int))
    return name,clf,scaler,calibrator,{x[1]:x[0] for x in options}


def predict(df,clf,scaler,calibrator):
    if df.empty:return np.array([],dtype=float)
    raw=clf.predict_proba(scaler.transform(df[list(FEATURES)]))[:,1]
    small=1e-12
    logit=np.log(np.clip(raw,small,1-small)/(1-np.clip(raw,small,1-small)))
    return calibrator.predict_proba(logit.reshape(-1,1))[:,1]


def calc_thresholds(cal:pd.DataFrame,pred:np.ndarray):
    """Use probability/volume quantiles, not historical PnL, to avoid 75% defaults."""
    if len(cal)!=len(pred):raise ValueError('Probability length mismatch')
    limits={}
    for strat in STRATEGIES:
        mask=cal[strat].to_numpy(dtype=bool)
        if np.count_nonzero(mask)<30:
            limits[strat]={'enabled':False,'reason':'fewer than 30 calibration strategy signals',
                           'n':int(mask.sum())}
            continue
        vals=cal.loc[mask]
        limits[strat]={'enabled':True,'n':len(vals),
                       'model_cutoff':float(np.percentile(pred[mask],PERCENTILE)),
                       'volume_cutoff':float(np.percentile(vals.volume_ratio.to_numpy(),PERCENTILE))}
    return limits


def simulate_portfolio(frame:pd.DataFrame, strat:str, admitted=None):
    """Fixed $200, 3 open positions, no concurrent same-symbol position."""
    if frame.empty:return []
    if admitted is None:admitted=np.ones(len(frame),dtype=bool)
    if len(admitted)!=len(frame):raise ValueError('Invalid admission mask')
    events=frame.loc[frame[strat].to_numpy(dtype=bool)&admitted]
    events=events.sort_values(['entry_at','symbol','time'])
    open_=[];trades=[]
    for r in events.itertuples(index=False):
        entry=int(r.entry_at)
        open_=[pos for pos in open_ if pos[0]>entry]
        if len(open_)>=MAX_POSITIONS or any(pos[1]==r.symbol for pos in open_):
            continue
        open_.append((int(r.exit_at),r.symbol))
        trades.append({'symbol':r.symbol,'time':int(r.time),'entry_at':entry,
                       'exit_at':int(r.exit_at),'net_return_pct':float(r.net_return_pct),
                       'pnl_usd':COST_USD*float(r.net_return_pct)/100,'won':int(r.won)})
    return trades


def metrics(trades:list[dict]):
    if not trades:return {'trades':0,'mean_net_pct':None,'win_rate':None,'total_net_usd':0,
                          'max_closed_drawdown_usd':None,'distinct_days':0}
    by_exit=sorted(trades,key=lambda t:(t['exit_at'],t['symbol']))
    pnl=np.array([x['pnl_usd'] for x in by_exit],dtype=float)
    equity=np.cumsum(pnl)
    peak=np.maximum.accumulate(np.r_[0,equity])
    draw=peak[1:]-equity
    return {'trades':len(by_exit),'mean_net_pct':float(np.mean([x['net_return_pct'] for x in by_exit])),
            'win_rate':float(np.mean([x['won'] for x in by_exit])),
            'total_net_usd':float(equity[-1]),
            'max_closed_drawdown_usd':float(np.max(draw)),
            'distinct_days':len(set(x['entry_at']//86_400_000 for x in by_exit))}


def block_ci(a:list[dict],b:list[dict],rounds=400):
    """Paired week-block bootstrap of total PnL difference, preserving simultaneous coins."""
    daily={}
    for trade in a:
        week=trade['entry_at']//(7*86_400_000)
        daily.setdefault(week,[0.,0.])[0]+=trade['pnl_usd']
    for trade in b:
        week=trade['entry_at']//(7*86_400_000)
        daily.setdefault(week,[0.,0.])[1]+=trade['pnl_usd']
    if len(daily)<12:return None
    gains=np.array([v[0]-v[1] for v in daily.values()])
    rng=np.random.default_rng(2026)
    simulations=np.sum(gains[rng.integers(0,len(gains),(rounds,len(gains)))],axis=1)
    return {'difference_usd':float(np.sum(gains)),
            'lower_5pct_usd':float(np.quantile(simulations,.05)),
            'upper_95pct_usd':float(np.quantile(simulations,.95)),
            'weeks':len(daily)}


def evaluate(part:pd.DataFrame,pred:np.ndarray,limits:dict):
    if len(part)!=len(pred):raise ValueError('Evaluation length mismatch')
    report={}
    for strat in STRATEGIES:
        control=simulate_portfolio(part,strat)
        vals={'unfiltered':metrics(control),'candidate_signals':int(part[strat].sum())}
        gate=limits.get(strat,{})
        if gate.get('enabled'):
            ai=simulate_portfolio(part,strat,pred>=gate['model_cutoff'])
            vol=simulate_portfolio(part,strat,part.volume_ratio.to_numpy()>=gate['volume_cutoff'])
            vals.update(ai_filtered=metrics(ai),volume_filtered=metrics(vol),
                        ai_minus_unfiltered_week_bootstrap=block_ci(ai,control),
                        ai_minus_volume_week_bootstrap=block_ci(ai,vol))
        else:
            vals['unavailable_filter_reason']=gate.get('reason','no validated calibration threshold')
        report[strat]=vals
    return report


def fit_and_report(ds:pd.DataFrame,provenance:dict):
    partitions=partition(ds)
    kind,clf,scaler,calibrator,selection_scores=pick_and_calibrate(partitions)
    thresholds_pred=predict(partitions['threshold_calibration'],clf,scaler,calibrator)
    limits=calc_thresholds(partitions['threshold_calibration'],thresholds_pred)
    diag=partitions['reused_diagnostic']
    scores=predict(diag,clf,scaler,calibrator)
    out={'schema':'confirmed-breakout-experiment-v3','research_only':True,'live_ml_enabled':False,
         'independent_out_of_sample_claim':False,
         'diagnostic_contaminated_by_prior_v2_review':True,
         'threshold_selection':'70th percentile of calibrated probabilities, within each strategy, from earlier threshold-calibration dates; no evaluation-return optimisation',
         'train_target':'confirmed hourly resistance breakouts only; target-first before stop over 24 hourly candles',
         'strategy_definitions':'matches V2 breakout, volume >=1.5x, prior compression <0.8 and volume >=1.2x, relative strength >=3pp and EMA9>EMA21>EMA50',
         'execution':'next-hour open proxy; 0.10% fee and 0.05% slippage per side; $200 per virtual trade; max 3 positions per independent portfolio; 24h max hold; same-hour stop-first',
         'model':kind,'model_selection_brier':selection_scores,
         'counts':{k:len(v) for k,v in partitions.items()},
         'splits':{k:{'first':datetime.fromtimestamp(v.time.min()/1000,timezone.utc).isoformat() if len(v) else None,
                      'last':datetime.fromtimestamp(v.time.max()/1000,timezone.utc).isoformat() if len(v) else None}
                   for k,v in partitions.items()},
         'candidate_count':len(ds),'historical_win_rate':float(ds.won.mean()),
         'thresholds':limits,
         'reused_diagnostic':evaluate(diag,scores,limits),
         'data_provenance':provenance,
         'caveats':['The 2025-26 evaluation period was reviewed in the previous V2 experiment and is NOT an untouched holdout.',
                    'Training/review decisions were influenced by the prior 2025-26 findings; prospective data beyond 2026-09 is necessary for independent validation.',
                    'Hour OHLC does not reveal stop/target order within the same candle (stop-first) or historic best ask spread.',
                    'Only a fixed subset of Binance symbols is included; missing and delisted assets may cause survivorship bias.',
                    'Day/week bootstrap is approximate and does not account for full market regime autocorrelation.',
                    'This report cannot switch on live or paper ML trading. No model parameters are written to models/latest.json.']}
    # Report AUC/Brier only as descriptive performance, not a trade profitability claim.
    if len(diag) and diag.won.nunique()>1:
        out['reused_diagnostic_probability']={'brier':float(brier_score_loss(diag.won,scores)),
                 'constant_baseline_brier':float(brier_score_loss(diag.won,np.full(len(diag),partitions['fit'].won.mean()))),
                 'auc':float(roc_auc_score(diag.won,scores))}
    if len(partitions['prospective_unseen']):
        # Don't publish prospective scores by default; a new separately dated and
        # protocol-locked verification job will do that after forward data accrues.
        out['prospective_samples_withheld']=int(len(partitions['prospective_unseen']))
    artifact={'schema':'confirmed-breakout-v3-1','research_only':True,'live_ml_enabled':False,
              'kind':kind,'features':list(FEATURES),
              'means':scaler.mean_.tolist(),'scales':scaler.scale_.tolist(),
              'calibration':{'a':float(calibrator.coef_[0,0]),'b':float(calibrator.intercept_[0])},
              'strategy_thresholds':limits,'cutoff_percentile':PERCENTILE,
              'model_training_end':'2023-08-30','prospective_approval':False,
              'note':'Experimental model must not replace models/latest.json or enable the ML trading account.'}
    if kind=='logistic':
        artifact.update({'coef':clf.coef_[0].tolist(),'bias':float(clf.intercept_[0])})
    else:
        artifact.update(original.serialize_gb(clf))
    return out,artifact


def download_dataset(args):
    end=args.end or (datetime.now(timezone.utc).replace(day=1).date().isoformat()[:7])
    requested_months=list(original.months(args.start,end))
    # Future/independence guard: the v3 retrospective report only ingests old
    # already-seen data, no October/November 2026 observations.
    requested_months=[m for m in requested_months if m<='2026-09']
    if not requested_months:raise ValueError('No months selected under fixed old-data research boundary')
    sym=[x.strip() for x in Path(args.symbols).read_text().splitlines() if x.strip() and not x.lstrip().startswith('#')]
    if 'BTCUSDT' not in sym:raise ValueError('BTCUSDT required for benchmarking')
    cache=Path(args.cache)
    tasks=[(s,m,cache) for s in sym for m in requested_months]
    if not args.offline:
        from concurrent.futures import ThreadPoolExecutor,as_completed
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            jobs={ex.submit(original.download_one,t):t for t in tasks}
            done=0
            for future in as_completed(jobs):
                done+=1
                try:future.result()
                except Exception as e:LOG.warning('Archive unavailable for %s: %s',jobs[future][:2],str(e))
                if done%200==0:LOG.info('Processed %s/%s historical archive requests',done,len(jobs))
    allowed=set(requested_months)
    data={s:original.load_symbol(s,cache,allowed) for s in sym}
    if len(data['BTCUSDT'])<85:raise ValueError('Missing verified BTC history')
    manifest=[]
    for s in sym:
        for f in sorted((cache/s).glob(f'{s}-1h-*.zip')):
            if f.name.removesuffix('.zip')[-7:] in allowed:
                # Prior load_symbol verifies checksum when the corresponding
                # checksum file exists. Record the exact source bytes.
                if f.with_suffix('.zip.CHECKSUM').exists():
                    manifest.append({'name':f.name,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()})
    provenance={'origin':'https://data.binance.vision','archives_verified':len(manifest),
                'manifest_sha256':hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest(),
                'symbols_available':{s:len(df) for s,df in data.items()},
                'history_requested':f'{requested_months[0]} to {requested_months[-1]}',
                'noncommercial_research_only':True}
    return construct_dataset(data,[s for s in sym if s!='BTCUSDT']),provenance


def main(argv=None):
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--symbols',default=str(BASE/'config/universe.txt'))
    ap.add_argument('--start',default='2017-08')
    ap.add_argument('--end',default='2026-09')
    ap.add_argument('--cache',default=str(BASE/'data/cache'))
    ap.add_argument('--workers',type=int,default=12)
    ap.add_argument('--offline',action='store_true')
    ap.add_argument('--report',default=str(BASE/'models/experiments/confirmed_breakouts_v3.json'))
    ap.add_argument('--model',default=str(BASE/'models/experiments/confirmed_breakouts_v3_model.json'))
    args=ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO,format='%(asctime)s %(levelname)s %(message)s')
    ds,provenance=download_dataset(args)
    report,model=fit_and_report(ds,provenance)
    out=Path(args.report);out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
    model_path=Path(args.model);model_path.parent.mkdir(parents=True,exist_ok=True)
    model_path.write_text(json.dumps(model,separators=(',',':'),allow_nan=False)+'\n')
    LOG.info('Research report written: %s; %s confirmed events, independent ML live gate OFF',out,len(ds))
    for strategy,rec in report['reused_diagnostic'].items():
        LOG.info('%s: unfiltered=%s AI=%s volume=%s',strategy,rec['unfiltered']['trades'],rec.get('ai_filtered',{}).get('trades'),rec.get('volume_filtered',{}).get('trades'))

if __name__=='__main__':main()