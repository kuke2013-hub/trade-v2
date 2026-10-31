# Cloudflare Worker: unattended V2 paper research

This Worker is an **independent, server-side, paper-only** experiment. It has no Binance account credentials and no exchange order-submission endpoint. It does not import or replace your browser-local V2 paper history. The original V1 repository remains unchanged.

**Status:** Source is prepared, but the Worker is **not deployed or scheduled** until a Cloudflare D1 database is created and the Worker is deployed to your account. GitHub–Cloudflare account linking alone does not deploy this service.

## Cloudflare setup (one-time, Free-plan pilot)

1. In [Cloudflare D1](https://dash.cloudflare.com/?to=/:account/workers/d1), select **Create database**. Name it exactly `trade-v2-paper`. Copy its UUID **Database ID**. The UUID is not a password.
2. **Completed:** `cloud/wrangler.jsonc` now contains the user's D1 database ID, with the binding name `DB` and database name `trade-v2-paper`. There is no need to edit the file in GitHub. **Never share Cloudflare API tokens or passwords.**
3. In [Cloudflare Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages), choose **Create application → GitHub**, and import `kuke2013-hub/trade-v2`. Set the **root directory to `cloud`**, and **Worker name to `trade-v2-monitor`** (the name must match `wrangler.jsonc`). Build/deploy command `npx wrangler deploy`; dependency install `npm install` if prompted. Cloudflare Workers Builds will then deploy the Worker from GitHub pushes.
4. Confirm the scheduled Cron Trigger `*/3 * * * *` and the D1 binding `DB` exist in the deployed Worker. The Worker automatically creates the `cloud_state` table on the first scheduled or status request, so no SQL migration is required for this first release.
5. Test `https://trade-v2-monitor.<your-workers-subdomain>.workers.dev/health` which should return `"dbBound":true`. After successful scheduled runs, `/api/status` will return a non-null `meta.lastSuccess`. In the V2 GitHub Pages dashboard, enter the Worker base URL into **Cloudflare paper monitor → Worker HTTPS URL** and select **Connect & refresh**.
6. Verify Cloudflare usage, Worker logs and Cron Triggers. The first few scheduled ticks may scan only a subset; this is by design. No simulation is retroactively backfilled if it was offline.

## Conservative budget and correctness

- Cron interval: **every 3 minutes**. A deterministic **17-pair** universe is divided into 5 shards; each pair is scanned roughly every **15 minutes**. BTCUSDT is fetched on every tick as the benchmark. This does **not** monitor all 360 pairs of the browser dashboard and may miss very short-lived opportunities.
- Entries use a fresh Binance spot best ask, completed 1-hour candles, the four existing rule-based strategy conditions, $200 per model virtual trade, a $10,000 starting virtual account per strategy, three open positions per strategy, +2% target, −1.5% stop, 24h maximum hold, 0.10% fees per side and 0.05% slippage per side.
- Exits are checked against completed Binance 1-minute candles on each tick, not live order-book ticks. If stop and target occur in one minute, the stop is assumed first. Data gaps are explicitly flagged. If prices are missing, no estimated open P&L is invented.
- A fifth ML strategy is eligible only if `models/latest.json` is published **and** `holdout.accepted === true` **and** the current signal passes the calibration-selected probability threshold. The recovered first model is **holdout-rejected**, so fifth-model paper trading must remain disabled.
- D1 holds a single persistent JSON research state with revision-checked compare-and-swap writes, preventing duplicate state commits from overlapping Cron invocations. Public GET endpoints provide only simulated status/trade information; HTTP requests cannot trigger trades or reset accounts.
- Current free Workers limits include **10 ms CPU time** and **50 external subrequests** per invocation, so benchmark real Worker usage. The workload is intentionally small and **free operation is not guaranteed** if real usage or traffic exceeds Cloudflare limits.
- This is for **noncommercial research**. Review Binance Vision historical-data terms before using historical-derived models commercially or placing live orders.

## API

- `GET /health`: Worker deployed, D1 binding present.
- `GET /api/status`: cloud simulation P&L, open positions, up to 100 closed trades, last successful scan, latest API errors, model gate status, and per-strategy totals.
- All other paths return 404; non-GET methods return 405. The read-only API returns CORS headers for the user's GitHub Pages domain.

## Local checks

From repository root:

```bash
node --test tests/cloud.test.mjs
node --test tests/engine.test.mjs tests/ml.test.mjs tests/trade-chart.test.mjs tests/cloud.test.mjs
```

This Worker's code uses the existing `engine.mjs` and `ml.mjs` directly to avoid divergence in entry, risk and model calculations. Its local deterministic tests use fixture exchange data only and do not claim production uptime, exchange access, or trading profitability.