# Performance: load test results

A k6 load test (`loadtest/vault.js`) runs three kinds of traffic at once against a real stack
(API, worker, PostgreSQL, MinIO in Docker) and fails if latency or errors pass set limits.

## How it was run

```bash
RATE_LIMIT_ENABLED=false docker compose up -d api
docker run --rm -i --network blackboxai-task_default -v "$PWD/loadtest:/scripts" \
  grafana/k6:1.3.0 run /scripts/vault.js
docker compose up -d api   # rate limits back on
```

Rate limits are switched off for the run only: every virtual user comes from one address, so
with them on the test would measure the limiter rather than the service.

**Machine:** a MacBook (10 CPU cores, 16 GB RAM), with Docker Desktop given 10 CPUs and 8 GB.
Everything (the load generator too) shares that one machine, so these numbers are a floor for
what the service does on dedicated hardware, not a capacity plan.

**Data:** one workspace seeded with 300 documents across 10 folders, plus one share link. The
upload scenario adds about 900 more during the run, so listings and search work on a growing
workspace (about 1,200 documents by the end).

## Traffic (3 minutes)

| Scenario | Load | Each iteration |
| --- | --- | --- |
| Browse | ramps to 40 people, holds 2 minutes, ramps down | list the root, list a folder, search the text of documents, load the dashboard, check notifications; then 1 s pause |
| Upload | 5 uploads/s | one small text file (then scanned, processed, indexed by the worker) |
| Share link | 20 opens/s | resolve the public link, then request its download |

## Results

31,025 requests in 3 minutes 7 s: **165 requests/s, 0 errors** (all 30,708 checks passed).

| Request | median | p90 | **p95** | p99 | max | threshold (p95) |
| --- | --- | --- | --- | --- | --- | --- |
| List documents | 22 ms | 146 ms | **214 ms** | 312 ms | 616 ms | < 300 ms ✓ |
| Search (names and contents) | 48 ms | 166 ms | **204 ms** | 320 ms | 682 ms | < 400 ms ✓ |
| Dashboard | 91 ms | 316 ms | **381 ms** | 501 ms | 951 ms | < 500 ms ✓ |
| Upload | 15 ms | 219 ms | **291 ms** | 485 ms | 728 ms | < 800 ms ✓ |
| Share link (open + download) | 3 ms | 63 ms | **98 ms** | 187 ms | 455 ms | < 200 ms ✓ |
| All requests | 20 ms | 160 ms | **235 ms** | 381 ms | 951 ms | |

## What it shows

- **Nothing failed.** No 5xx, no timeouts, no pool exhaustion: the API's pools and the job queue
  (uploads trigger scanning, processing and notification jobs) kept up.
- **Medians are low, tails come from contention.** Every scenario shares one PostgreSQL on the
  same machine as the load generator; p95 is five to ten times the median, which is CPU
  contention rather than slow queries.
- **The dashboard is the heaviest read.** It aggregates the whole workspace (counts, 14-day
  series, storage by type, top links) on every load. It already reads from `readPool`, so a
  read replica takes it off the primary; the next step would be caching it for a few seconds per
  workspace.
- **Share links are cheap.** Resolving a token is one indexed lookup plus a counter update;
  the download is a redirect to a signed URL, so file bytes never pass through the API.
- **Uploads stay fast while the worker does the heavy work.** The request only stores the
  object and the row; scanning, thumbnails and text extraction run as jobs.

## Watching a run

With the observability compose profile (see docker-compose.yml), Prometheus shows the same picture from the
server side: `vault_http_request_duration_seconds` by route, `vault_jobs` for queue depth, and
`vault_db_pool_connections` for waiting clients.
