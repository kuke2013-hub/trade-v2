# V3 confirmed-breakout AI research — first actual results

**Status: trained; no validated profitable trading edge; live/paper ML trading remains disabled.**

This report is generated from GitHub Actions run [41259846855](https://github.com/kuke2013-hub/trade-v2/actions/runs/41259846855), using checksum-verified Binance monthly spot data. The companion JSON and model are preserved in this directory. Neither is loaded by the live V2 trader.

The study identified **37,545 confirmed breakout events** across 19 tradable historical coins (plus BTC as the benchmark), with **1,779 verified monthly ZIP archives**. The historical target-first rate was 35.59%.

The selected model was **gradient_boosting**. Its retrospective diagnostic Brier score was 0.2292 versus 0.2304 for the constant-rate benchmark; AUC was 0.5317.

## Retrospective comparison

| Original strategy | Unfiltered trades | Unfiltered avg net/trade | AI-filtered trades | AI avg net/trade | Volume-only avg net/trade |
|---|---:|---:|---:|---:|---:|
| Resistance breakout | 1,710 | -0.357% | 967 | -0.349% | -0.354% |
| Volume confirmation | 1,465 | -0.332% | 703 | -0.373% | -0.363% |
| Compression release | 476 | -0.182% | 170 | -0.316% | -0.212% |
| Relative strength | 992 | -0.346% | 443 | -0.370% | -0.402% |

**Every strategy/filter combination had negative mean simulated net returns.** AI filtering reduced the total dollar losses primarily because it reduced the number of trades; that alone does not demonstrate a better strategy. In three of four cases, AI filtering actually worsened average net return per trade compared with the unfiltered strategy.

## Methodology and important limitations

- Historical features and labels use completed 1-hour Binance spot candles; entry is the following hourly open. Target +2%, stop −1.5%, maximum 24 hours, 0.1% fee and 0.05% slippage per side. When an hourly candle touches both stop and target, assume the stop first.
- Four separate historical portfolios, $200 per position and no more than three concurrent positions per strategy. Same-coin overlapping positions are excluded.
- Logistic regression and gradient boosting were trained on confirmed breakouts (not mere near-resistance candidates), model selection was performed chronologically, Platt calibration applied on a separate period, and each AI/volume threshold was the earlier period’s fixed 70th percentile.
- Training, model selection, probability calibration, threshold calibration, and the previous already-examined 2025–26 period are segregated with 24-hour purges.
- **The 2025–26 period is not an untouched test**: the original V2 research already examined it. There is no newly independent holdout yet. Data strictly later than September 2026 is needed for prospective evidence.
- AUC near 0.53 means very weak ranking ability. Correlated opportunities, asset selection, historical open-price proxy and one-hour stop-order ambiguity limit accuracy. The research cohort is not a point-in-time complete Binance listing universe.
- No V3 model was published to `models/latest.json`; no existing Cloudflare D1 data, scanner rules, or the live/paper portfolios have been changed.

**Decision:** Do not enable AI trading. The original +2%/−1.5% long breakout premise needs to be challenged, rather than trying to find a threshold that makes a losing historical strategy appear profitable.