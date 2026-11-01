# Trade V2 — unattended Binance Spot paper experiment

**Implemented, but gated until you configure the shared secret and enable scheduled GitHub collection.**

Architecture: **GitHub Actions (every five minutes) → official Binance public Spot data → existing V2 paper engine → authenticated HTTPS API → Cloudflare D1 → GitHub Pages dashboard**. No exchange account/API key, no real orders. A first connection probe on GitHub Actions returned HTTP 200 for hourly candles, minute candles, and a best bid/ask quote from `data-api.binance.vision` on 1 November 2026. This is an observation from one runner, not a guarantee of ongoing market-data access.

Cloudflare Cron Triggers were deliberately disabled (`"crons": []`) because Cloudflare's scheduled executions received Binance HTTP 451 (regional restriction). **Do not re-enable the Cloudflare Cron**; GitHub is the collector. The Cloudflare Worker is now a persistent **storage API only**, protected for writes by a strong secret. This is a noncommercial research-only, paper simulation. V1 is untouched.

## One-time secure activation

1. Create a random **shared secret locally** on your Mac using Terminal: `openssl rand -hex 32`. Copy its 64-character output. **Do not paste it into ChatGPT, a repository file, or a public issue.**
2. Cloudflare → Workers & Pages → `trade-v2-monitor` → **Settings → Variables and Secrets → Add**. Choose **Secret** (not plaintext); name `TRADE_V2_INGEST_TOKEN`, value the secret from step 1. Save/deploy it. Keep the existing `DB` binding to D1 `trade-v2-paper`.
3. GitHub → `kuke2013-hub/trade-v2` → **Settings → Secrets and variables → Actions → Secrets → New repository secret**. Name exactly `TRADE_V2_INGEST_TOKEN`, with **the same secret value**.
4. Confirm Cloudflare Worker deployment has ingested this code and that [`/health`](https://trade-v2-monitor.kuletski2013.workers.dev/health) returns `collectorSecretConfigured: true`. Its public `/api/status` endpoint must still work; `/api/state` without auth should return 401 (never public).
5. GitHub → **Actions → V2 unattended Binance paper collector (five-minute pilot) → Run workflow**. Inspect the run log. A successful authenticated run reports a JSON object with `scanned`, `revision`, `marketDataHost:'data-api.binance.vision'`. It never prints the secret. Inspect the public [`/api/status`](https://trade-v2-monitor.kuletski2013.workers.dev/api/status) after the run. `meta.lastSuccess` must be populated, `meta.collector` must read `github-actions`, and `meta.lastScanCount` must be > 0.
6. **Only after step 5 succeeds**, in GitHub **Settings → Secrets and variables → Actions → Variables**, create repository variable `TRADE_V2_COLLECTOR_ENABLED` with value `true`. That enables the five-minute schedule. Remove the variable or set it to `false` to pause scheduled collection, without resetting D1 history. Manual workflow runs remain possible.

The fixed Worker URL is `https://trade-v2-monitor.kuletski2013.workers.dev`. The V2 dashboard knows it automatically. It reads cloud results from `/api/status`; never requires the secret and cannot place trades or alter D1.

## Integrity and constraints

- GitHub Actions uses a bounded **17-symbol USDT Spot universe** and checks each symbol every completed scheduled run. **5-minute scheduling is best-effort**; GitHub can delay or drop runs, so heartbeat freshness in the dashboard is essential.
- Signals use only completed 1h candles, prior 24h resistance and the four original rule-based strategies. Exits use available completed 1m Binance candles and conservative stop-first tie handling. Starting virtual balances: $10,000 in each of 5 distinct research portfolios ($50,000 total); $200 notional per entry, max 3 positions per strategy; +2% target, −1.5% stop, 24h exit timeout, 0.1% simulated fees/side, 0.05% simulated slippage/side.
- The fifth ML portfolio is **disabled** because the recovered real historical model did not pass its holdout trading gate. No model probability is a guarantee or evidence of a positive net-trading edge.
- Binance data host is intentionally limited to `https://data-api.binance.vision` on GitHub because it responded to the required public endpoints. Binance HTTP 429, 451, missing BTC benchmark, or other failures **do not trigger trades or update success timestamps**. No proxy, location bypass, or exchange substitution is attempted.
- Cloudflare's publicly accessible HTTP Worker **does not fetch Binance or run paper trades**. Its only protected operations are `GET /api/state` and `POST /api/commit`, both requiring a 32+ character **secret** (`Authorization: Bearer`). Commit validates the D1 revision (optimistic concurrency), checked run ID, unchanged portfolio history, no reset, and a nonempty full-universe Binance scan. Replayed run IDs are idempotent.
- The token lives in **GitHub Actions Secrets** and a **Cloudflare Worker Secret**, never in source code, logs or the browser. If leaked, rotate both secrets. The Worker's D1 ID is not confidential.
- Cloudflare Free CPU limits and GitHub Actions availability apply. A successful simulated trade is not a measured net live-execution advantage; minute candles cannot reproduce the exact historical fill order or market depth.
- This project is noncommercial research, subject to Binance's data terms and applicable regional eligibility rules. Avoid live trading or redistributing Binance Vision datasets without confirming the requisite permissions.

## Source and workflow

- `cloud/collector.mjs`: unattended GitHub runner; uses the **same `tick()`**/paper engine as V2, with all 17 eligible pairs and the official, permitted Binance market-data host. Authenticated state read + compare-and-swap D1 commit.
- `cloud/worker.mjs`: read-only public `/health`, `/api/status`, `/api/binance-diagnostics`; secret-protected `/api/state` and `/api/commit`; no live trading.
- `.github/workflows/collect-paper.yml`: manual pilot and optional gated every-five-minute schedule. No repository write permission.
- `cloud/wrangler.jsonc`: D1 binding and `triggers: { crons: [] }`.
- `tests/cloud.test.mjs`: deterministic synthetic-fixture tests for tick logic, secrets, D1 read/write, replay and stale-write rejection. Synthetic fixtures are **never** production data.

Local tests from repository root: `node --test tests/engine.test.mjs tests/trade-chart.test.mjs tests/ml.test.mjs tests/cloud.test.mjs`.