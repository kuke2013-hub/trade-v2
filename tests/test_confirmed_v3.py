"""Synthetic fixtures for the isolated confirmed-breakout research design."""
import unittest
import sys
from pathlib import Path
import numpy as np
import pandas as pd
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'research_v3'))
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'research'))
import confirmed_breakouts as v3
import pipeline as v2

H=v2.HOUR

def bars(*,size=360,start='2023-01-01',spike=140):
    t=int(pd.Timestamp(start,tz='UTC').timestamp()*1000)
    out=[]
    for i in range(size):
        p=100+i*.01
        if i==spike: p+=9
        o=p-.7 if i==spike else p-.05
        hi=p+.1 if i==spike else p+.25
        lo=p-.9 if i==spike else p-.25
        out.append((t+i*H,o,hi,lo,p,200+i%11))
    return pd.DataFrame(out,columns=['time','open','high','low','close','volume'])

class TestBreakoutV3(unittest.TestCase):
    def test_extended_label_matches_published_v2_math_and_exit_chronology(self):
        x=bars()
        for i in (70,139,140,141,150):
            a=v2.simulate_label(x,i)
            b=v3.historical_label(x,i)
            self.assertEqual(a['exit_reason'],b['exit_reason'])
            self.assertAlmostEqual(a['net_return_pct'],b['net_return_pct'],places=10)
            self.assertEqual(a['won'],b['won'])
            self.assertGreater(b['exit_at'],b['entry_at'])
            self.assertLessEqual(b['exit_at']-b['entry_at'],24*H)

    def test_extreme_breakout_not_lost_to_old_three_percent_proximity_filter(self):
        x=bars()
        f=v2.features_for_symbol(x,x)
        self.assertTrue(bool(f.iloc[140].confirmed))
        self.assertFalse(bool(f.iloc[140].candidate))
        e=v3.triggered(x,x,symbol='TESTUSDT')
        spike=e[e.time==x.iloc[140].time]
        self.assertEqual(len(spike),1)
        self.assertGreater(float(spike.iloc[0].breakout_excess_pct),3)
        self.assertTrue(bool(spike.iloc[0].breakout))

    def test_ema_seeding_matches_reference_definition(self):
        c=pd.Series([float(i) for i in range(1,31)])
        e=v3.ema_seeded(c,9)
        self.assertTrue(np.isnan(e[7]))
        self.assertEqual(e[8],5.)
        self.assertEqual(e[9],6.)

    def test_split_is_chronological_with_purge_and_no_prior_holdout_reuse_as_blind(self):
        start=pd.Timestamp('2023-01-01',tz='UTC')
        d=pd.DataFrame({'time':[(start+pd.Timedelta(days=i)).value//1000000 for i in range(1300)],
                        'symbol':'ETHUSDT','won':0})
        parts=v3.partition(d)
        for a,b in zip(v3.SPLITS,v3.SPLITS[1:]):
            self.assertGreater(parts[b].time.min()-parts[a].time.max(),24*H)
        self.assertEqual(len(parts['prospective_unseen']),0)

    def test_calibration_cutoffs_are_per_strategy_and_no_forced_seventyfive_percent(self):
        f=pd.DataFrame({'volume_ratio':[1.7+i/10 for i in range(60)],
            'breakout':[True]*60,'volume':[True]*60,'compression':[False]*60,'strength':[False]*60})
        scores=np.linspace(.10,.32,len(f))
        limit=v3.calc_thresholds(f,scores)
        self.assertAlmostEqual(limit['breakout']['model_cutoff'],np.quantile(scores,.7))
        self.assertLess(limit['breakout']['model_cutoff'],.52)
        self.assertFalse(limit['strength']['enabled'])

    def test_portfolio_capacity_overlap_exits_and_same_symbol(self):
        entries=[]
        t=1_800_000_000_000
        for i,s in enumerate(['AAA','AAA','BBB','CCC','DDD','EEE']):
            entries.append(dict(symbol=s,time=t+i*H,entry_at=t+H,exit_at=t+H+24*H,
                                net_return_pct=1.,won=1,breakout=True,volume=True,
                                compression=True,strength=True,volume_ratio=2.))
        f=pd.DataFrame(entries)
        trades=v3.simulate_portfolio(f,'breakout')
        self.assertEqual([x['symbol'] for x in trades],['AAA','BBB','CCC'])
        self.assertEqual(v3.metrics(trades)['total_net_usd'],6.)

    def test_bootstrap_returns_null_without_enough_weeks(self):
        a=[dict(entry_at=1_800_000_000_000,pnl_usd=2.)]
        self.assertIsNone(v3.block_ci(a,[]))

    def test_clipping_guard_fails_without_real_history(self):
        with self.assertRaises(ValueError):v3.construct_dataset({'BTCUSDT':bars(size=80)},['ETHUSDT'])

if __name__=='__main__':unittest.main()