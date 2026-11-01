# Confirmed breakout AI filter experiment — V3 (noncommercial research)

This experiment **does not change** the running cloud collector, its D1 trade history, the four V2 portfolios, or the existing rejected `models/latest.json`.

## The question

Does a machine-learning model trained **only on confirmed hourly resistance breakouts** improve net trading returns versus (a) taking all qualifying strategy signals and (b) a simple volume filter? The evaluation compares the four deployed rules independently: pure breakout, volume >= 1.5x, compression with volume >= 1.2x, and relative BTC strength + EMA trend. Model features are available as of candle close; the return uses the next hourly open.

## Important methodological corrections

- Use all valid confirmed breakouts, **including moves >3% above prior resistance**. The previous near-resistance dataset omitted these disproportionately large events.
- Require the actual volume, compression, and EMA trend conditions for each of four strategies; never treat a broad near-resistance candidate as an eligible live setup.
- Fit on earlier history, choose model type on a later period, calibrate probabilities in a third period, and set each strategy's model/volume threshold in a fourth period. Add 24-hour purge windows between partitions.
- Select the top **30%** of prior calibration examples using each strategy's calibrated probability. Use the same 70th-percentile rule for a volume-only filter. This is a **precommitted fraction**, never a fixed 75% success-probability requirement. If there are fewer than 30 calibration examples, report the filter as unavailable rather than inventing a fallback.
- Account for fee/slippage, hourly stop-first ambiguity, $200 per trade, a cap of three simultaneous independent portfolio positions, and duplicate same-symbol exposure. Report trade counts, net USD PnL, mean net per trade, win fraction, closed-trade drawdown, and paired block-bootstrap results.
- **Do not** call the September 2025–September 2026 results an untouched holdout. Those dates were used to inspect V2's earlier research, so they are an **already-reviewed retrospective diagnostic**. Future data **strictly after September 2026** is required for an independently prospective evaluation.
- No v3 artefact switches on ML paper trading. The newly generated `models/experiments/*` model is research-only and not a substitute for the production `models/latest.json`.

## Run

The GitHub Actions workflow **V3 confirmed-breakout AI filter experiment** starts automatically on a commit to `research_v3/` or can be run manually. It retrieves authenticated SHA-256-checksummed monthly Binance Vision data, with cached ZIPs when available, then publishes only a downloadable Actions artifact containing an experiment report and an **isolated** model JSON. It does **not** push models into the live code.

```bash
pip install -r research/requirements.txt
python -m unittest discover -s tests -p 'test_*.py' -v
python research_v3/confirmed_breakouts.py --start 2017-08 --end 2026-09
```

## Remaining limitations

1. The fixed Binance asset universe is not a full point-in-time listing/delisting universe and remains subject to survivorship bias. Some delisted tokens are included in training but not currently tradable.
2. Using next-hour **open** to model entries and hourly OHLC candles for exits cannot reconstruct actual bid/ask spreads or intrahour order sequence. Stops take precedence if both thresholds were touched in one hour.
3. The cross-sectional observations and returns overlap, so apparent observations are not independent. The week-block bootstrap is approximate, not a guarantee of future returns.
4. At a fixed 30% admission rate, model and volume filters may generate different trade counts in different market regimes. Compare profitability per trade, total PnL, risk and opportunity count together.
5. The project is noncommercial historical research subject to Binance Vision dataset terms. No order placement, no leverage, no Binance API keys, and no proof of a profitable edge.