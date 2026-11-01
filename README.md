# Binance Breakout Lab V2 — Historical ML Research

**Repository:** https://github.com/kuke2013-hub/trade-v2  
**Intended GitHub Pages:** https://kuke2013-hub.github.io/trade-v2/

A standalone V2 fork of the original Binance Breakout Lab. **V1 (`kuke2013-hub/trade`) remains untouched.** V2 has an additional research-only historical-data-trained fifth strategy. It does not use invented model parameters, returns or backtest results.

## Honest status: what works before training?

The cloned dashboard, live Binance USDT spot scanner, four rule-based paper portfolios, one-minute refresh, candlestick charts, historical trade markers and local trade history are functional independently of historical model training.

**Before a real Binance Vision training workflow completes, V2 shows `UNTRAINED` and no ML probabilities.** The fifth portfolio is present, but will NOT open paper positions. After actual historical training the published `models/latest.json` can score each pair using exactly the same 1-hour features as training. It can open virtual paper entries **only if** the *untouched out-of-sample holdout* clears the positive-result gate. A trained but rejected model still displays research estimates, explicitly labelled with the failed holdout, and does not paper-trade.

## The historical data (2017–2026, subject to availability)

The source is [Binance Vision](https://data.binance.vision/) monthly spot `1h` ZIP archives:

`https://data.binance.vision/data/spot/monthly/klines/<SYMBOL>/1h/<SYMBOL>-1h-YYYY-MM.zip`

The dataset **begins in 2017**, so there are not yet ten full years of Binance Spot data as of 31 October 2026. Different cryptocurrencies have different historical start/end dates; missing months are skipped, not invented. The default 20-symbol historical cohort includes a few delisted symbols, but is **not a comprehensive point-in-time listing universe**, therefore survivorship bias remains.

- Fetches monthly archives by symbol and date, and validates official `.CHECKSUM` SHA-256 files.
- Converts Binance Spot timestamps from milliseconds (before 2025) and microseconds (from 2025).
- Enforces contiguous 1-hour histories. Gaps invalidate the corresponding features or 24h future-label window.
- Features cover distance to prior 24h high, 1h/4h/24h returns, BTC benchmark relative performance, relative volume, close position, volatility/range compression, ATR, SMA ratios and hourly dollar-volume proxy.
- Candidate cohort includes both approaching resistance (within 3% below the prior high) and recent moves within 3% above it. Feature and candidate selection use closed hourly candles only.
- Historical **outcome**: whether buying at *next hour's open* would reach +2% before −1.5% within 24h. The next-hour open is a *proxy*, NOT historical best ask. OHLC-bar conflicts assume stop-first. Simulated fees 0.1%/side and slippage 0.05%/side are included in net-return assessment.
- Strictly chronological training, calibration and a final untouched last-year holdout, with 24h purge gaps between segments.
- Trains a standardised logistic regression and gradient boosting; selects by validation Brier score, calibrates probabilities on a later period, and reports calibration vs baseline plus holdout performance.
- Chooses the live paper probability threshold on calibration only, using **confirmed breakout** candidates. Holdout checks the same population. A model is accepted for paper entries only with improved holdout Brier, at least 40 selected signals, positive mean net return and a positive lower bound from day-block bootstrap (5th percentile).
- Tracks exact archive SHA-256 manifests, symbols, dates, observations and train/calibration/test count in `models/report.json`. The public web artefact `models/latest.json` contains model parameters and a summary, but never raw historical ZIP files.

### Run training yourself (macOS or Linux)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r research/requirements.txt
python research/pipeline.py --start 2017-08 --symbols config/universe.txt
```

The first run may retrieve many months of data and take substantial time. Checksummed ZIPs are cached in ignored `data/cache/` and reused. You can also run in offline mode to train from already downloaded cached archives:

```bash
python research/pipeline.py --offline --start 2017-08
```

`models/latest.json` and `models/report.json` are only created if sufficient authentic historical data and chronological splits are available. The GitHub **Train historical Binance ML model** Actions workflow runs when the training files are first committed and can also be launched manually from **Actions → Train historical Binance ML model → Run workflow**. It downloads and validates data, trains, then commits model/report back to `main` if repository Actions have write permission. The training job may fail because of unavailable archives, network limits, or insufficient coverage; this is a **valid no-model result**, not a reason to insert a fabricated model.

## V2 model integration

`ml.mjs` is a no-network pure inference implementation. It validates the published JSON schema and evaluates the trained logistic or gradient-boosting model on **closed hourly candles**, with the same features/clamps defined in Python. The status panel shows model provenance, holdout Brier, baseline Brier, observation count and selected threshold. Explorer cards and top radar list calibrated historical estimates when available. These are estimates, never guaranteed probabilities or trading advice.

The fifth `$10,000` paper account `Historical ML filter` is a **new** model that is allowed to enter only after the model is successfully trained AND the untouched test gates pass AND the current signal is a confirmed hourly breakout AND the model estimate meets the calibration-selected threshold. Otherwise it remains inactive. The original four strategies are unchanged and available as controls.

All paper portfolios use `$200` allocations, at most 3 positions, +2% target, −1.5% stop, 24h timeout, fees/slippage as disclosed. All trading is **hypothetical and browser-only**; no private keys, Binance account access, short positions, futures, margin, or live execution. If both stop and target touch the same minute, the simulator assumes stop-first.

**Important browser data isolation:** V2 uses `breakout-v2-paper-1`, `breakout-v2-armed` and `breakout-v2-chart-interval` in `localStorage`, distinct from V1 keys on the same GitHub Pages origin. Your existing V1 paper history is untouched by V2.

## Deployment

The `.github/workflows/pages.yml` workflow publishes the website from `main`. **GitHub may require a one-time Pages setting:** Settings → Pages → Build and deployment → Source: **GitHub Actions**. The workflow requires Pages and workflow permissions. If Pages is not enabled, the source repository still works but the URL will not go live until enabled. You can also serve locally with `python3 -m http.server 8000` and visit `http://localhost:8000/`.

GitHub Actions `.github/workflows/ci.yml` independently tests the historical Python parser, labels and split logic, JS indicator/trade/math/model prediction, and the Chromium browser interaction. Synthetic test fixtures are **test-only**; they never appear in production data or a published model.

## Known scientific limitations

1. Historical 1h candles cannot reconstruct minute-level order of stops or exact market execution prices. Stop-first ties remain a conservative proxy, not true tick replay.
2. Overlapping candidate events and market regime changes reduce sample independence. The day-block bootstrap is approximate. Chronological splits alone do not prove future profitability.
3. The 20-symbol default cohort underrepresents delisted/failed coins. Expand with a genuine historical listing/delisting point-in-time universe before interpreting an edge as robust.
4. A single held-out year cannot establish persistent advantage through future market regimes. Add walk-forward, per-coin, per-regime, fee sensitivity, and order-book validation before any deployment discussion.
5. Binance Vision data licenses limit the permissible uses of these archives. This repo is **noncommercial open research and paper-trading experimentation only**. **Do not use Binance Vision datasets or models trained from them for commercial distribution or live proprietary order execution without checking licensing and obtaining any necessary permissions.** See [Binance Vision Dataset Terms](https://github.com/binance/binance-public-data/blob/master/TERMS_AND_CONDITIONS.md). Redistributed derivatives must retain appropriate attribution and noncommercial share-alike terms where required.
6. Browser scanning pauses when the tab is closed or background-throttled; API prices are not a tick-level replay. No open model trades are entered without a fresh best-ask quote.

## Project files

- `index.html`, `styles.css` — monochrome research dashboard
- `app.mjs`, `engine.mjs`, `trade-chart.mjs` — live scanner, fixed-rule baselines, simulated execution
- `ml.mjs` — historical model inference with no fabricated fallback
- `research/pipeline.py`, `research/requirements.txt` — checksum-aware downloader, labelling, model training, out-of-sample gate
- `config/universe.txt` — explicitly documented historical research cohort
- `models/latest.json`, `models/report.json` — produced only by genuine training
- `tests/` — browser, JS, Python unit tests
- `.github/workflows/` — CI, Pages, historical training

The data source is Binance Vision, supplied free for noncommercial research subject to its published terms. Independent research does not imply Binance endorsement.


## 2026-10-31: actual historical model recovered from completed GitHub training

The first historical training completed against **1,779 checksum-verified monthly Binance archives**, with **20 symbols** and **717,842 labelled candidate observations** (dataset through 2026-09-29). Its trained model `models/latest.json` is a gradient-boosting classifier; the complete research report is `models/report.json`.

**Crucial: the untouched holdout did NOT accept this model for paper trading.** Holdout Brier = **0.2057346982** versus constant baseline **0.2107306276**, holdout AUC ≈ **0.5947**, but the calibration-selected trading threshold (0.75) yielded **zero selected trades** in calibration and holdout. Therefore there is **no demonstrated positive net trading edge** and the ML portfolio remains **disabled**, even though historical prediction estimates can be displayed with their research caveats.

The original training GitHub Action failed *after* training because a concurrent code commit made its `git push` non-fast-forward. Model and report were recovered from the exact GitHub Actions workflow artifact, without re-training, and the workflow was adjusted to rebase before publication on future runs. This is a restored research record, not a newly inferred or fabricated score.

## Unattended GitHub + Cloudflare paper collector (pilot)

Trade V2 now contains a gated [five-minute GitHub Actions Binance data collector and secure Cloudflare D1 storage](cloud/README.md). This replaces the Cloudflare Cron approach because Cloudflare Cron requests received a Binance HTTP 451, while a GitHub runner successfully retrieved Binance hourly and minute candles and best bid/ask quotes.

**This is not active until the same strong secret is stored privately in both GitHub Actions Secrets and the Cloudflare Worker Secrets, a manual test workflow passes, and GitHub repository variable `TRADE_V2_COLLECTOR_ENABLED` is set to `true`.** The Cloudflare Worker has no cron trigger and never places trades. Its public dashboard API is read-only; the authenticated writer uses D1 optimistic concurrency checks and a GitHub run id. The original V1 and the browser-only V2 paper portfolios are untouched.

The ML model remains holdout-rejected and cannot open ML paper trades. GitHub Actions scheduling is best-effort, not guaranteed five-minute execution; market-data access, trading performance and free-tier capacity require ongoing monitoring.