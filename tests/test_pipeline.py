"""Synthetic *unit tests only*. Never publish synthetic observations as a model."""
import io
import math
import tempfile
import unittest
import zipfile
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'research'))
from pipeline import normalize_timestamp,validate_checksum,archive_to_rows,simulate_label,features_for_symbol,split_chronological,FEATURES
import pandas as pd

class ResearchTests(unittest.TestCase):
    def test_timestamp_units_before_and_after_2025(self):
        self.assertEqual(normalize_timestamp('1704067200000'),1704067200000)
        self.assertEqual(normalize_timestamp('1735689600000000'),1735689600000)
        with self.assertRaises(ValueError):normalize_timestamp('123')
    def test_checksum_rejects_tampering(self):
        import hashlib
        content=b'fake archive';sha=hashlib.sha256(content).hexdigest().encode()
        self.assertEqual(validate_checksum(content,sha+b'  archive.zip','archive.zip'),sha.decode())
        with self.assertRaises(ValueError):validate_checksum(content+b'!',sha,'archive.zip')
    def test_mixed_timestamps_and_kline_parser(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'test.zip'
            with zipfile.ZipFile(path,'w') as z:
                z.writestr('test.csv','1704067200000,100,101,99,100,10,1704070799999\n1735689600000000,100,101,99,100,10,1735693199999999\n')
            rows=archive_to_rows(path)
            self.assertEqual(rows[0][0],1704067200000)
            self.assertEqual(rows[1][0],1735689600000)
    def test_ambiguous_hourly_extremes_stop_first(self):
        t=1704067200000;rows=[]
        for i in range(30):
            if i==1: hi,lo=103,97
            else:hi,lo=100.3,99.7
            rows.append((t+i*3600000,100,hi,lo,100,100))
        bars=pd.DataFrame(rows,columns=['time','open','high','low','close','volume'])
        target=simulate_label(bars,0)
        self.assertEqual(target['won'],0)
        self.assertEqual(target['exit_reason'],'stop')
        self.assertLess(target['net_return_pct'],-1.5)
    def test_gap_rejects_future_label(self):
        t=1704067200000
        bars=pd.DataFrame([(t+i*3600000,100,101,99,100,100) for i in range(30)],columns=['time','open','high','low','close','volume'])
        bars.loc[9,'time']+=3000
        self.assertIsNone(simulate_label(bars,0))
    def test_splits_purge_overlap_around_boundaries(self):
        # One row per day over five years; purged 24h at both date cutoffs.
        start=pd.Timestamp('2020-01-01',tz='UTC');df=pd.DataFrame({'time':[(start+pd.Timedelta(days=i)).value//1000000 for i in range(1800)], 'symbol':'BTCUSDT','won':0})
        tr,cal,te=split_chronological(df)
        self.assertTrue(len(tr)>100 and len(cal)>100 and len(te)>100)
        self.assertGreater(cal.time.min()-tr.time.max(),2*24*3600000)
        self.assertGreater(te.time.min()-cal.time.max(),2*24*3600000)
    def test_feature_frame_uses_valid_last_1h_bars(self):
        t=1704067200000;rows=[]
        for i in range(130):
            p=100+i*.03+(i%3==0)*.1-(i%3==1)*.1
            rows.append((t+i*3600000,p-.12,p+.50,p-.51,p,100+i%7))
        df=pd.DataFrame(rows,columns=['time','open','high','low','close','volume'])
        f=features_for_symbol(df,df)
        self.assertEqual(len(f),130)
        self.assertTrue(f.iloc[-1].candidate)
        self.assertEqual(len(FEATURES),15)

    def test_python_live_feature_parity(self):
        # Compare the actual browser inferencer against the historical training builder.
        import subprocess,json
        t=1704067200000;rows=[]
        for i in range(95):
            price=100+i*.03+(i%3==0)*.1-(i%3==1)*.1
            rows.append({'time':t+i*3600000,'open':price-.12,'high':price+.50,'low':price-.51,
                         'close':price,'volume':100+i%7,'closeTime':t+(i+1)*3600000-1})
        frame=pd.DataFrame(rows)
        py=features_for_symbol(frame,frame).iloc[-1]
        js='import {mlFeatures} from "./ml.mjs";let d=JSON.parse(process.argv[1]);console.log(JSON.stringify(mlFeatures(d,d)));'
        output=subprocess.run(['node','--input-type=module','-e',js,json.dumps(rows)],
            cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True,check=True)
        values=json.loads(output.stdout)
        for name in FEATURES:self.assertAlmostEqual(float(py[name]),values[name],places=8,msg=name)

if __name__=='__main__':unittest.main()