#!/usr/bin/env python3
"""Noncommercial historical research for Binance Breakout Lab V2.

No fake returns and no model are written if authentic checked Binance Vision files,
market-contiguous labels, chronological splits or sufficient observations are absent.
The model is historical research only and cannot send real exchange orders.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import logging
import math
import os
import random
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.preprocessing import StandardScaler

BASE = 'https://data.binance.vision/data/spot/monthly/klines'
HOUR = 3_600_000
FEATURES = [
    'distance_pct','return_1h','return_4h','return_24h','btc_24h','relative_24h',
    'volume_ratio','range_pct','close_location','compression_ratio','sma9_21_pct',
    'sma21_50_pct','atr_pct','quote_volume_log','confirmed'
]
BOUNDS = [(-3,3),(-40,40),(-60,60),(-100,250),(-40,60),(-200,200),
          (0,100),(0,100),(0,1),(0,8),(-50,50),(-60,60),(0,100),(0,15),(0,1)]
TARGET=0.02
STOP=0.015
FEE=0.001
SLIPPAGE=0.0005
HORIZON=24
LOG=logging.getLogger('breakout-v2')


def normalize_timestamp(value: str) -> int:
    """Binance Vision spot switched from millisecond to microsecond epoch in 2025."""
    n=int(value)
    if n>10**15:
        n//=1000
    if not 1_480_000_000_000 <= n <= 2_100_000_000_000:
        raise ValueError('Invalid historical epoch: '+str(value))
    return n


def months(start: str, end: str):
    y,m=map(int,start.split('-')); yy,mm=map(int,end.split('-'))
    while (y,m)<=(yy,mm):
        yield f'{y:04d}-{m:02d}'
        m+=1
        if m==13:y,m=y+1,1


def remote_bytes(url: str, attempts=3):
    for attempt in range(attempts):
        try:
            request=urllib.request.Request(url,headers={'User-Agent':'BreakoutLabV2-NoncommercialResearch/0.1'})
            with urllib.request.urlopen(request,timeout=28) as response:
                result=response.read(8_000_001)
                if len(result)>8_000_000:
                    raise ValueError('Archive too large; refusing '+url)
                return result
        except urllib.error.HTTPError as exc:
            if exc.code==404:return None
            if exc.code not in [429,500,502,503,504]:raise
        except (urllib.error.URLError,TimeoutError):
            pass
        time.sleep(1.5*(attempt+1))
    raise RuntimeError('Archive fetch failed: '+url)


def validate_checksum(data: bytes, checksum: bytes, filename: str) -> str:
    expected=checksum.decode('utf-8').split()[0].lower()
    if len(expected)!=64 or not all(c in '0123456789abcdef' for c in expected):
        raise ValueError('Invalid SHA-256 checksum file')
    actual=hashlib.sha256(data).hexdigest()
    if actual!=expected:raise ValueError(f'Checksum mismatch for {filename}')
    return actual


def download_one(args):
    symbol,month,cache=args
    name=f'{symbol}-1h-{month}.zip'; path=cache/symbol/name
    check=path.with_suffix('.zip.CHECKSUM')
    url=f'{BASE}/{symbol}/1h/{name}'
    if path.exists() and check.exists():
        try:
            content=path.read_bytes();digest=validate_checksum(content,check.read_bytes(),name)
            return (symbol,month,digest,'cached')
        except (ValueError,OSError):
            path.unlink(missing_ok=True);check.unlink(missing_ok=True)
    payload=remote_bytes(url)
    if payload is None:return (symbol,month,None,'not_listed')
    checksum=remote_bytes(url+'.CHECKSUM')
    if checksum is None:raise RuntimeError('Published data lacks CHECKSUM: '+url)
    digest=validate_checksum(payload,checksum,name)
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix('.tmp');tmp.write_bytes(payload);tmp.replace(path)
    check.write_bytes(checksum)
    return (symbol,month,digest,'downloaded')


def archive_to_rows(path: Path):
    result=[]
    with zipfile.ZipFile(path) as z:
        members=[i for i in z.infolist() if i.filename.lower().endswith('.csv') and '/' not in i.filename]
        if len(members)!=1 or members[0].file_size>25_000_000:
            raise ValueError('Unexpected ZIP layout for '+path.name)
        with z.open(members[0]) as raw:
            text=io.TextIOWrapper(raw,encoding='utf8',newline='')
            for row in csv.reader(text):
                if len(row)<7 or not row[0].lstrip('-').isdigit():continue
                try:
                    ts=normalize_timestamp(row[0]); values=[float(row[i]) for i in (1,2,3,4,5)]
                    if ts%HOUR or not all(map(math.isfinite,values)) or min(values[:4])<=0 or values[3]<=0 or values[4]<0:continue
                    op,hi,lo,cl,vol=values
                    if hi<max(op,cl,lo) or lo>min(op,cl):continue
                    result.append((ts,op,hi,lo,cl,vol))
                except (ValueError,OverflowError):continue
    return result


def load_symbol(symbol: str, cache: Path, allowed_months: set):
    rows=[]
    for archive in sorted((cache/symbol).glob(f'{symbol}-1h-*.zip')):
        if archive.name.removesuffix('.zip')[-7:] not in allowed_months:
            continue
        check=archive.with_suffix('.zip.CHECKSUM')
        if not check.exists():continue
        validate_checksum(archive.read_bytes(),check.read_bytes(),archive.name)
        rows.extend(archive_to_rows(archive))
    if not rows:return pd.DataFrame(columns=['time','open','high','low','close','volume'])
    frame=pd.DataFrame(rows,columns=['time','open','high','low','close','volume'])
    return frame.sort_values('time').drop_duplicates('time',keep='last').reset_index(drop=True)


def features_for_symbol(df: pd.DataFrame, btc: pd.DataFrame):
    """All features use only information available by the *close* of hour t."""
    if len(df)<85 or len(btc)<85:return pd.DataFrame()
    c,h,l,v=df.close,df.high,df.low,df.volume
    r=(h-l)/c
    prior_res=h.shift(1).rolling(24).max()
    dist=100*(prior_res-c)/prior_res
    close_loc=((c-l)/(h-l)).where(h>l,0.5)
    prevvol=v.shift(1).rolling(20).mean()
    recent=r.shift(1).rolling(8).mean()
    old=r.shift(9).rolling(24).mean()
    tr=pd.concat([h-l,(h-c.shift(1)).abs(),(l-c.shift(1)).abs()],axis=1).max(axis=1)
    sma9=c.rolling(9).mean();sma21=c.rolling(21).mean();sma50=c.rolling(50).mean()
    btcframe=btc[['time','close']].copy()
    btcframe['btc_24h']=(btcframe.close/btcframe.close.shift(24)-1)*100
    btcframe['btc_contiguous']=(btcframe.time.diff().eq(HOUR)).rolling(24,min_periods=24).sum().eq(24)
    b24=btcframe.set_index('time')['btc_24h'].reindex(df.time).to_numpy()
    bvalid=btcframe.set_index('time')['btc_contiguous'].reindex(df.time).fillna(False).to_numpy()
    dayret=(c/c.shift(24)-1)*100
    f=pd.DataFrame({
        'time':df.time,
        'distance_pct':dist,
        'return_1h':(c/c.shift(1)-1)*100,
        'return_4h':(c/c.shift(4)-1)*100,
        'return_24h':dayret,
        'btc_24h':b24,
        'relative_24h':dayret-b24,
        'volume_ratio':(v/prevvol).where(prevvol>0,0),
        'range_pct':100*r,
        'close_location':close_loc,
        'compression_ratio':(recent/old).where(old>0,0),
        'sma9_21_pct':(sma9/sma21-1)*100,
        'sma21_50_pct':(sma21/sma50-1)*100,
        'atr_pct':tr.rolling(14).mean()/c*100,
        'quote_volume_log':np.log10(np.maximum(1,c*v)),
        'confirmed':((c>prior_res*1.001)&(close_loc>=0.6)).astype(int),
    })
    # Require the last 54 hourly intervals to be consecutive, not simply 55 records.
    f['contiguous']=df.time.diff().eq(HOUR).rolling(54,min_periods=54).sum().eq(54).to_numpy()&bvalid
    for name,(lo,hi) in zip(FEATURES,BOUNDS):f[name]=f[name].clip(lo,hi)
    f['candidate']=dist.between(-3,3)&f.contiguous&np.isfinite(f[FEATURES]).all(axis=1)
    return f


def simulate_label(df: pd.DataFrame, index: int):
    """Next-hour open proxy. OHLC ties conservatively stop first. Fee/slippage included."""
    if index+HORIZON>=len(df):return None
    future=df.iloc[index+1:index+HORIZON+1]
    previous=df.time.iloc[index]
    for t in future.time:
        if int(t)-int(previous)!=HOUR:return None
        previous=t
    entry_market=float(future.iloc[0].open)
    if entry_market<=0:return None
    buy=entry_market*(1+SLIPPAGE)
    stop_market=buy*(1-STOP)/(1-SLIPPAGE)
    target_market=buy*(1+TARGET)/(1-SLIPPAGE)
    reason='time';sell_market=float(future.iloc[-1].close)
    for row in future.itertuples():
        if row.low<=stop_market:
            reason='stop';sell_market=stop_market;break
        if row.high>=target_market:
            reason='target';sell_market=target_market;break
    net_return=100*((sell_market*(1-SLIPPAGE)*(1-FEE))/(buy*(1+FEE))-1)
    return {'won':int(reason=='target'),'net_return_pct':net_return,'exit_reason':reason}


def build_dataset(data: dict[str,pd.DataFrame]):
    btc=data.get('BTCUSDT')
    if btc is None or len(btc)<85:raise ValueError('Historical BTCUSDT benchmark missing')
    results=[]
    for sym,df in data.items():
        if len(df)<85:continue
        features=features_for_symbol(df,btc)
        if features.empty:continue
        ix=np.flatnonzero(features.candidate.to_numpy())
        records=[]
        for i in ix:
            label=simulate_label(df,int(i))
            if label is None:continue
            rec={name:float(features.iloc[i][name]) for name in FEATURES}
            rec.update(label);rec['symbol']=sym;rec['time']=int(df.iloc[i].time)
            records.append(rec)
        if records:
            results.extend(records)
            LOG.info('Candidate samples %-12s %7d, full hourly bars %7d',sym,len(records),len(df))
    if not results:raise ValueError('No real candidate/label pairs derived')
    return pd.DataFrame(results).sort_values(['time','symbol']).reset_index(drop=True)


def split_chronological(dataset: pd.DataFrame):
    # Use the most recent year as untouched test, preceding year as calibration,
    # all prior available history for fitting. Purge 24h at both boundaries.
    tmax=datetime.fromtimestamp(int(dataset.time.max())/1000,timezone.utc)
    test_start=datetime(tmax.year-1,tmax.month,1,tzinfo=timezone.utc)
    calib_start=datetime(test_start.year-1,test_start.month,1,tzinfo=timezone.utc)
    test_ms=int(test_start.timestamp()*1000);cal_ms=int(calib_start.timestamp()*1000)
    purge=HORIZON*HOUR
    train=dataset[dataset.time<cal_ms-purge].copy()
    calibration=dataset[(dataset.time>=cal_ms+purge)&(dataset.time<test_ms-purge)].copy()
    test=dataset[dataset.time>=test_ms+purge].copy()
    return train,calibration,test


def platt(scores, labels):
    p=LogisticRegression(C=10.0,max_iter=400,solver='lbfgs').fit(np.asarray(scores).reshape(-1,1),labels)
    return float(p.coef_[0,0]),float(p.intercept_[0])


def predict_proba(score,a,b):
    z=np.clip(a*np.asarray(score,dtype=float)+b,-60,60)
    return 1/(1+np.exp(-z))


def bootstrap_daily_lower(df: pd.DataFrame, selected: np.ndarray, iterations=400):
    tmp=df.loc[selected,['time','net_return_pct']].copy()
    if len(tmp)<40:return float('nan')
    tmp['day']=tmp.time//86_400_000
    groups=[g.net_return_pct.to_numpy() for _,g in tmp.groupby('day')]
    if len(groups)<20:return float('nan')
    rng=np.random.default_rng(2026)
    n=len(groups);sampled=[]
    for _ in range(iterations):
        picks=rng.integers(0,n,size=n)
        samples=np.concatenate([groups[i] for i in picks])
        sampled.append(samples.mean())
    return float(np.percentile(sampled,5))


def serialize_gb(gb: GradientBoostingClassifier):
    trees=[]
    for estimator in gb.estimators_[:,0]:
        t=estimator.tree_; nodes=[]
        for i in range(t.node_count):
            feature=int(t.feature[i])
            nodes.append({'f':feature if feature>=0 else -1,'t':float(t.threshold[i]) if feature>=0 else 0,
                          'l':int(t.children_left[i]) if feature>=0 else -1,
                          'r':int(t.children_right[i]) if feature>=0 else -1,
                          'v':float(t.value[i,0,0]) if feature<0 else 0})
        trees.append(nodes)
    p=float(gb.init_.class_prior_[1])
    return {'trees':trees,'init_logodds':math.log(p/(1-p)), 'learning_rate':float(gb.learning_rate)}


def train(dataset: pd.DataFrame, provenance: dict):
    train_df,cal_df,test_df=split_chronological(dataset)
    counts={'train':len(train_df),'calibration':len(cal_df),'test':len(test_df)}
    if min(counts.values())<250 or train_df.symbol.nunique()<3 or len(set(train_df.won))<2 or len(set(cal_df.won))<2:
        raise ValueError(f'Insufficient authentic chronology/asset coverage for validation: {counts}')
    scaler=StandardScaler().fit(train_df[FEATURES])
    X=scaler.transform(train_df[FEATURES]);Xc=scaler.transform(cal_df[FEATURES]);Xt=scaler.transform(test_df[FEATURES]);
    y=train_df.won.to_numpy();yc=cal_df.won.to_numpy();yt=test_df.won.to_numpy()
    candidates={
       'logistic':LogisticRegression(C=0.1,max_iter=450,solver='lbfgs',random_state=2026),
       'gradient_boosting':GradientBoostingClassifier(n_estimators=85,learning_rate=.045,max_depth=2,
              min_samples_leaf=110,subsample=.72,random_state=2026)
    }
    options=[]
    for kind,clf in candidates.items():
        clf.fit(X,y)
        raw=clf.decision_function(Xc)
        a,b=platt(raw,yc);p=predict_proba(raw,a,b)
        options.append((brier_score_loss(yc,p),kind,clf,a,b))
        LOG.info('Calibration %s Brier %.5f',kind,options[-1][0])
    options.sort(key=lambda x:x[0]);brier_cal,kind,chosen,a,b=options[0]
    pp=predict_proba(chosen.decision_function(Xt),a,b)
    pc=predict_proba(chosen.decision_function(Xc),a,b)
    baseline=float(np.mean(y));base_brier=float(brier_score_loss(yt,np.full(len(yt),baseline)))
    test_brier=float(brier_score_loss(yt,pp))
    # Threshold is selected ONLY using the preceding calibration period, never test.
    choices=[]
    for threshold in [0.52,0.55,0.58,0.60,0.63,0.66,0.70,0.75]:
        selected=(pc>=threshold)&(cal_df.confirmed.to_numpy()>0.5);n=int(selected.sum())
        if n<50:continue
        mean_return=float(cal_df.loc[selected,'net_return_pct'].mean())
        choices.append((mean_return,threshold,n))
    _,threshold,n_cal=max(choices,key=lambda x:x[0]) if choices else (float('-inf'),.75,0)
    selected=(pp>=threshold)&(test_df.confirmed.to_numpy()>0.5)
    selected_n=int(selected.sum())
    selected_avg=float(test_df.loc[selected,'net_return_pct'].mean()) if selected_n else None
    lower=bootstrap_daily_lower(test_df,selected)
    accepted=(test_brier<base_brier and selected_n>=40 and selected_avg is not None
              and selected_avg>0 and math.isfinite(lower) and lower>0)
    auc=float(roc_auc_score(yt,pp)) if len(set(yt))==2 else None
    report={
        'counts':counts,'symbols':sorted(dataset.symbol.unique().tolist()),'candidate_samples':len(dataset),
        'first_sample_utc':datetime.fromtimestamp(int(dataset.time.min())/1000,timezone.utc).isoformat(),
        'last_sample_utc':datetime.fromtimestamp(int(dataset.time.max())/1000,timezone.utc).isoformat(),
        'split_train_last_utc':datetime.fromtimestamp(int(train_df.time.max())/1000,timezone.utc).isoformat(),
        'split_cal_first_utc':datetime.fromtimestamp(int(cal_df.time.min())/1000,timezone.utc).isoformat(),
        'split_test_first_utc':datetime.fromtimestamp(int(test_df.time.min())/1000,timezone.utc).isoformat(),
        'selected_model':kind,'calibration_brier':float(brier_cal),'test_brier':test_brier,
        'test_baseline_brier':base_brier,'test_auc':auc,'test_win_rate':float(yt.mean()),
        'threshold':float(threshold),'calibration_selected_n':n_cal,'holdout_selected_n':selected_n,
        'holdout_selected_avg_net_pct':selected_avg,'paper_entry_population':'Only confirmed hourly breakouts with learned probability above selected threshold',
        'holdout_daily_bootstrap_5pct_lower_net_pct':lower if math.isfinite(lower) else None,
        'accepted_for_paper_experiment':accepted,'fees_and_slippage_included':True,
        'caveats':['Hourly OHLC exits are proxies; if both stop and target touch within an hour, stop is assumed first.',
                   'Historical best ask, spread and order book cannot be reconstructed from these 1h candles.',
                   'Candidate events overlap across hours and symbols, so bootstrap is only an approximate uncertainty analysis.',
                   'Historical symbol list is not a comprehensive delisted-asset universe; survivorship bias remains.',
                   'A positive single holdout does not prove future profitability.'],
        'source':provenance
    }
    model={
        'schema':'breakout-v2-1','trained_on':'Binance Vision spot 1h','generated_utc':datetime.now(timezone.utc).isoformat(),
        'kind':kind,'features':FEATURES,'means':scaler.mean_.tolist(),
        'scales':np.where(scaler.scale_>0,scaler.scale_,1.0).tolist(),
        'calibration':{'a':a,'b':b},'threshold':float(threshold),
        'holdout':{'brier':test_brier,'baseline_brier':base_brier,'accepted':accepted,
                   'samples':len(test_df),'selected_trades':selected_n,'selected_avg_net_pct':selected_avg,
                   'bootstrap_lower_net_pct':lower if math.isfinite(lower) else None},
        'coverage':{'symbols':len(report['symbols']),'observations':len(dataset),
                    'from':report['first_sample_utc'],'through':report['last_sample_utc'],
                    'archives_verified':provenance['archives_verified']},
        'research_only':True,
        'license':'Binance Vision noncommercial research. See https://github.com/binance/binance-public-data/blob/master/TERMS_AND_CONDITIONS.md'
    }
    if kind=='logistic':model.update({'coef':chosen.coef_[0].tolist(),'bias':float(chosen.intercept_[0])})
    else:model.update(serialize_gb(chosen))
    return model,report


def main():
    parser=argparse.ArgumentParser(description='Train noncommercial V2 model on checksum-verified Binance Vision historical hourly archives')
    previous_month=(datetime.now(timezone.utc).date().replace(day=1)-timedelta(days=1)).strftime('%Y-%m')
    parser.add_argument('--start',default='2017-08');parser.add_argument('--end',default=previous_month)
    parser.add_argument('--symbols',default='config/universe.txt');parser.add_argument('--cache',default='data/cache')
    parser.add_argument('--output',default='models/latest.json');parser.add_argument('--report',default='models/report.json')
    parser.add_argument('--offline',action='store_true');parser.add_argument('--workers',type=int,default=12)
    args=parser.parse_args();logging.basicConfig(level=logging.INFO,format='%(asctime)s %(levelname)s %(message)s')
    symbols=[s.strip().split('#')[0].strip().upper() for s in Path(args.symbols).read_text().splitlines()]
    symbols=list(dict.fromkeys(s for s in symbols if s and s.endswith('USDT')))
    if 'BTCUSDT' not in symbols:symbols.insert(0,'BTCUSDT')
    mos=list(months(args.start,args.end));cache=Path(args.cache)
    tasks=[(symbol,m,cache) for symbol in symbols for m in mos]
    state=[]
    if not args.offline:
        with ThreadPoolExecutor(max_workers=max(1,min(16,args.workers))) as executor:
            futures={executor.submit(download_one,t):t for t in tasks}
            for i,f in enumerate(as_completed(futures)):
                try:state.append(f.result())
                except Exception as exc:
                    LOG.warning('Archive unavailable %s: %s',futures[f][:2],str(exc))
                if (i+1)%200==0:LOG.info('Examined %d of %d monthly archives',i+1,len(tasks))
    else:LOG.info('Offline: using already cached checksum-verified monthly archives')
    allowed=set(mos)
    data={symbol:load_symbol(symbol,cache,allowed) for symbol in symbols}
    actual=[symbol for symbol,df in data.items() if len(df)>=85]
    verified_files=[]
    for s in symbols:
        for path in (cache/s).glob(f'{s}-1h-*.zip'):
            if path.name.removesuffix('.zip')[-7:] in allowed:
                verified_files.append({'filename':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    provenance={'origin':'https://data.binance.vision','archives_verified':len(verified_files),
                'archive_sha256_manifest':verified_files,'symbols_requested':symbols,
                'symbols_with_bars':actual,'months_requested':len(tasks),
                'downloaded':sum(s[3]=='downloaded' for s in state),
                'not_listed':sum(s[3]=='not_listed' for s in state)}
    LOG.info('Verified %d archives; symbols with usable bars %d/%d',len(verified_files),len(actual),len(symbols))
    dataset=build_dataset(data)
    LOG.info('Extracted %d labelled candidate samples',len(dataset))
    model,report=train(dataset,provenance)
    # Keep large manifest in report, not in the browser's model artifact.
    model['coverage']['requested_symbols']=symbols
    out=Path(args.output);out.parent.mkdir(parents=True,exist_ok=True)
    reportfile=Path(args.report);reportfile.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(model,separators=(',',':'))+'\n')
    reportfile.write_text(json.dumps(report,indent=2,default=str)+'\n')
    LOG.info('Published %s model; holdout Brier=%.5f baseline=%.5f; paper eligible=%s',model['kind'],model['holdout']['brier'],model['holdout']['baseline_brier'],model['holdout']['accepted'])

if __name__=='__main__':main()