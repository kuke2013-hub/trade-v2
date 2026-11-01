#!/usr/bin/env python3
"""Verified, read-only Binance Vision ETHUSDT SPOT kline archival export.

No authentication, trades, futures, private account access or executions.
Outputs are intended solely for noncommercial research.
"""
import csv
import datetime as dt
import hashlib
import io
import json
import pathlib
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path("data/ethusdt_history")
BASE = "https://data.binance.vision/data/spot"
SYMBOL = "ETHUSDT"
COLUMNS = [
    "open_time_utc", "open", "high", "low", "close", "volume_eth",
    "close_time_utc", "volume_usdt", "number_of_trades",
    "taker_buy_volume_eth", "taker_buy_volume_usdt", "ignore",
]
MONTHS = [f"{y}-{m:02d}" for y in range(2017, 2027)
          for m in range(1, 13) if "2017-08" <= f"{y}-{m:02d}" <= "2026-09"]
DAYS = [(dt.date(2026, 10, 1) + dt.timedelta(days=i)).isoformat() for i in range(31)]


def get(url):
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "ETHUSDT-historical-research/1"})
            with urllib.request.urlopen(request, timeout=35) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            if exc.code not in (429, 500, 502, 503, 504) or attempt == 3:
                raise
        except (TimeoutError, OSError):
            if attempt == 3:
                raise
        time.sleep(2 ** attempt)
    raise RuntimeError("unreachable")


def utc(raw):
    value = int(raw)
    seconds = value / (1_000_000 if value > 10**14 else 1000)
    return dt.datetime.fromtimestamp(seconds, tz=dt.timezone.utc).isoformat().replace("+00:00", "Z")


def fetch(job):
    interval, period, granularity = job
    name = f"{SYMBOL}-{interval}-{period}.zip"
    url = f"{BASE}/{granularity}/klines/{SYMBOL}/{interval}/{name}"
    archive = get(url)
    if archive is None:
        return {"name": name, "missing": True, "rows": []}
    checksum = get(url + ".CHECKSUM")
    if not checksum:
        raise RuntimeError(f"Missing checksum: {name}")
    expected = checksum.decode("ascii").split()[0].lower()
    actual = hashlib.sha256(archive).hexdigest()
    if actual != expected:
        raise RuntimeError(f"SHA256 mismatch: {name}")
    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        items = [item for item in zf.namelist() if item.endswith(".csv")]
        if len(items) != 1:
            raise RuntimeError(f"Unexpected archive: {name}")
        raw = zf.read(items[0]).decode("utf-8-sig")
    parsed = []
    for row in csv.reader(io.StringIO(raw)):
        if len(row) != 12:
            raise RuntimeError(f"Bad CSV record in {name}")
        if not row[0].isdigit():
            continue
        parsed.append([utc(row[0]), *row[1:6], utc(row[6]), *row[7:]])
    return {"name": name, "sha256": actual, "missing": False, "rows": parsed}


def write_csv(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fp:
        writer = csv.writer(fp)
        writer.writerow(COLUMNS)
        writer.writerows(records)


def main():
    jobs = [(interval, month, "monthly") for interval in ("1h", "1d") for month in MONTHS]
    jobs += [(interval, day, "daily") for interval in ("1h", "1d") for day in DAYS]
    data = {"1h": {}, "1d": {}}
    missing = []
    manifests = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        for job, result in zip(jobs, pool.map(fetch, jobs)):
            interval = job[0]
            if result["missing"]:
                missing.append(result["name"])
                continue
            manifests.append({"file": result["name"], "sha256": result["sha256"], "count": len(result["rows"])})
            for row in result["rows"]:
                data[interval][row[0]] = row
    if len(data["1h"]) < 50000 or len(data["1d"]) < 2000:
        raise RuntimeError("Insufficient real Binance ETHUSDT observations; no export created.")
    for oldfile in ROOT.glob("ETHUSDT_*.csv"):
        oldfile.unlink()
    hourly_by_half = {}
    for stamp, row in sorted(data["1h"].items()):
        month = int(stamp[5:7])
        label = stamp[:4] + ("_H1" if month <= 6 else "_H2")
        hourly_by_half.setdefault(label, []).append(row)
    for label, records in sorted(hourly_by_half.items()):
        write_csv(ROOT / f"ETHUSDT_1h_{label}.csv", records)
    daily = [row for stamp, row in sorted(data["1d"].items())]
    write_csv(ROOT / "ETHUSDT_1d_all.csv", daily)
    summary = {
        "symbol": "ETHUSDT", "market": "Binance Spot", "source": BASE,
        "base_asset": "ETH", "quote_asset": "USDT",
        "timeframes": {"1h": len(data["1h"]), "1d": len(data["1d"])},
        "range_utc": {
            "1h_first": min(data["1h"]), "1h_last": max(data["1h"]),
            "1d_first": min(data["1d"]), "1d_last": max(data["1d"])
        },
        "missing_archives": missing,
        "archive_count_checksum_verified": len(manifests),
        "archive_manifest": manifests,
        "columns": COLUMNS,
        "note": "SPOT only. Raw Binance monthly and daily kline archives SHA256-verified; millisecond/microsecond times normalized to UTC. No synthetic fills."
    }
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / "manifest.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({k: v for k, v in summary.items() if k != "archive_manifest"}, indent=2))


if __name__ == "__main__":
    main()
