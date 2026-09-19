# Technical Design — File Storage & Sharing

Status: **Implementation reference.** See [`README.md`](README.md) for how to run it and what it does.
The original design followed `file_storage_sharing_takehome_blueprint.pdf`; everything built since
(recorded in the README and the ADRs) extends it without changing its foundations.

Companion docs: [`docs/`](docs/) · ADRs: [`docs/adr/`](docs/adr/) · API: [`docs/04-api-spec.md`](docs/04-api-spec.md)

---

## 1. Goal

Document storage, external sharing, workspaces, invitations and access control, built the way a
small product team would run it in production: correct under concurrency, safe across tenants,
observable, and cheap to operate.

`Browser → Next.js → Fastify API → PostgreSQL (metadata, queue, search) + S3/MinIO (bytes)`

**Modular monolith**: one codebase, two processes (API and worker), PostgreSQL as the only stateful
service besides object storage. No microservices, no Redis, no Kafka, no Elasticsearch, no ORM.

---

## 2. Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | **Next.js + TypeScript + Tailwind** | App Router; the browser only talks to the web origin |
| Backend | **Node.js + TypeScript + Fastify 5** | Lightweight, fast, good hooks for security and metrics |
| Contracts | **Zod + `@asteasolutions/zod-to-openapi`** | One definition validates requests, documents the API and types the web client |
| Database | **PostgreSQL 16 + `pg`, raw SQL** | Explicit queries; also the queue, search, rate limits and live updates |
| Migrations | **Ordered `.sql` files + a small runner** | The schema is the reviewable artefact |
| Files | **S3 API (MinIO locally)** | Bytes never in PostgreSQL; any S3 works |
| Auth | **Server-side sessions** (HttpOnly cookie) **+ personal API tokens** | Revocation takes effect on the next request |
| Processing | `sharp`, `pdfjs-dist` + `@napi-rs/canvas`, `yauzl`, `pdf-lib`, `yazl` | Thumbnails, text extraction, watermarks, zips; native dependencies installed during the Docker build |
| Optional services | ClamAV, Gotenberg (LibreOffice), Prometheus, Jaeger | Compose profiles |
| Observability | `@prometheus-io/client`, OpenTelemetry SDK, pino | Metrics port, OTLP traces, structured logs with trace ids |
| Testing | **Vitest** (API, against real PostgreSQL and MinIO), **Playwright** + axe-core (end-to-end), **k6** (load) | |
| Infra | **Docker Compose**; images pinned by digest | `docker compose up --build` is the whole setup |

---

## 3. Processes

```
                     ┌──────────────────────────────────┐
 Browser (member)    │  web — Next.js         :3000     │  server.mjs: security headers, real
 Browser (recipient) │  rewrites /api/* ────────────────┼──┐  client address, 404/410 for dead links
                     └──────────────────────────────────┘  │
                     ┌─────────────────────────────────────▼─┐
                     │  api — Fastify                  :4000 │ ──► /metrics on :9464
                     │  routes → services → repositories     │
                     └───────┬───────────────────────┬───────┘
                             │  jobs (same transaction) │
                     ┌───────▼───────┐               ┌──▼──────────────────────────┐
                     │  PostgreSQL   │◄──────────────│  worker — same code         │ ──► /metrics on :9464
                     │  :5432        │  SKIP LOCKED  │  email, fan-out, scans,     │
                     └───────────────┘  LISTEN/NOTIFY│  processing, webhooks,      │
                             ▲                       │  purges, maintenance        │
                     ┌───────┴────────┐              └──┬──────────────────────────┘
                     │ MinIO / S3     │◄────────────────┘   ──► ClamAV, Gotenberg, SMTP, webhooks
                     │ :9000          │◄── browser: direct part uploads, signed downloads
                     └────────────────┘
```

A one-off **migrate** container runs first, as the database owner: it applies migrations and
creates or updates `vault_app`, the least-privilege role the API and worker connect as.

---

## 4. Project layout

```
apps/api/
  migrations/                  001–037, forward-only SQL
  src/
    main.ts · worker.ts · migrate-cli.ts · maintenance.ts     entry points
    server.ts · services.ts · config.ts · policy.ts
    contracts/                 Zod schemas (validation + OpenAPI)
    modules/<name>/            routes · service · repo: auth, workspaces, documents (archive, versions),
                               folders, uploads, shares, folder-shares, audit, notifications, overview,
                               tokens, webhooks, maintenance
    jobs/                      the queue and its handlers
    processing/                text, thumbnails, Office conversion, pdf.js loader
    scanning/                  ClamAV client
    storage/                   FileStorage, S3Storage, object keys
    db/                        pools, transactions, tenant scoping, migrations, app role
    lib/                       errors, tokens, logger (redaction), csv, safe-http (SSRF guard), slots
    observability/             metrics, tracing
    openapi/                   document builder, route reference
  tests/                       unit · integration · security · contract
apps/web/                      Next.js app, server.mjs
e2e/                           Playwright specs (including accessibility)
loadtest/                      k6 script
ops/                           Prometheus configuration
```

---

## 5. Request lifecycle

```
request
  → helmet · cookie · per-route rate limit (PostgreSQL store) · metrics timer · pino (request id, redaction)
  → identity hook (onRequest)        Authorization: Bearer vlt_… → token owner   (a bad token is never ignored)
                                     else session cookie → sha256 → session row
  → preHandler requireSession        401 without a user; 403 for a read-only token on a write
            or requireBrowserSession  also refuses API tokens (account security, workspace deletion)
  → handler
      requireMember(workspaceId)     role from workspace_members, per request              else 404
      Permissions / requireOwner     policy.ts                                              else 403
      Zod parse                      after authorization, so outsiders all get the same 404
      → service (transaction boundary; jobs enqueued in the same transaction)
      → repository (parameterised SQL; multi-row reads inside withTenant for RLS)
  → error handler                    { error: { code, message, details? } }; unknown errors are opaque 500s
```

---

## 6. Data access

- **Pools.** `pool` for requests, `directPool` for `LISTEN` and advisory locks (bypasses a
  transaction-pooling PgBouncer), `readPool` for replica-tolerant reads (the dashboard, the trail).
  A statement timeout bounds every query.
- **Tenant scoping, twice.** Every workspace-scoped query filters by `workspace_id`. Multi-row reads
  also run in `withTenant(pool, userId, …)`, which sets `app.user_id` for the transaction; row-level
  security policies then return only rows from the caller's workspaces. Outside a tenant transaction
  (jobs, public routes) the policies allow everything, so they add protection without changing
  behaviour.
- **The application role** can read and write rows and nothing else: no DDL, no `TRUNCATE`, not a
  superuser, no `BYPASSRLS`, and no `UPDATE`/`DELETE` on `audit_events`.
- **Concurrency is decided in SQL**: quota reservation, download limits, invitation acceptance,
  the last-owner rule and code consumption are single conditional statements or row locks, each
  covered by a test that races two requests.
- **Keyset pagination** everywhere a list can grow; cursors carry PostgreSQL's own text form of the
  sort value, because JavaScript dates drop microseconds.

---

## 7. The job queue

`jobs` table: queue name, JSON payload, `run_at`, attempts, status, dedupe key. Enqueued with the
caller's transaction (the outbox pattern: no job without its change, no change without its job).
Workers claim with `FOR UPDATE SKIP LOCKED`, are woken by `NOTIFY`, retry with exponential backoff and
end in `failed` after `max_attempts`. A dedupe key collapses repeated unfinished work; `once` makes
scheduled work run once per slot.

| Queue | Does |
| --- | --- |
| `email.send` | SMTP (Mailpit locally) |
| `notifications.fanout` | One notification per workspace member, honouring preferences |
| `document.scan` | ClamAV `INSTREAM`; quarantine on a hit |
| `document.process` | Thumbnail, search text, Office preview |
| `document.checksum` | SHA-256 of direct uploads |
| `webhook.deliver` | Signed POST, retried with backoff |
| `workspace.purge` | Deletes a deleted workspace's objects and rows |
| `maintenance.run` | Hourly: retention, partitions, re-queueing, digests |

---

## 8. Storage and files

```ts
export interface FileStorage {
  upload(key: string, stream: Readable, contentType: string): Promise<void>;
  download(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresIn: number, options?: SignedUrlOptions): Promise<string>;
  copy?(sourceKey: string, targetKey: string): Promise<void>;
}
```

**Keys** come only from server UUIDs: `workspaces/{ws}/documents/{doc}`, `…/versions/{doc}/{uuid}`,
`…/derived/{doc}/{uuid}.webp|pdf`. Versions and derived objects never live under a document's own key,
because a file-system backed store can't hold an object and a "directory" at the same path.

**Uploads.**
- *Direct* (the web app): start a session (quota reserved), sign 8 MiB parts, the browser PUTs them to
  storage in parallel and can resume, `complete` checks the object's first bytes against the declared
  type, creates the row and queues the scan or processing. Abandoned sessions are aborted and their
  quota released by maintenance.
- *Buffered* (API clients, new versions): up to 25 MB in memory so the bytes are checked before
  anything is stored; at most `MAX_CONCURRENT_UPLOADS` at once, the next gets 503 with `Retry-After`.
- The object is always written before the row, and deleted again if the row can't be written.

**Downloads** are 302s to signed URLs (60 seconds by default). Revocation blocks new URLs; an
already-issued URL remains usable until it expires. Zips stream from storage through the API (stored
entries, exact length, ZIP64 when needed, safe entry names). View-only content streams too.

**The MinIO signing gotcha.** Inside Compose the API reaches MinIO as `minio:9000`, which a browser
can't resolve, and the signature covers the host. Two clients: one internal, one signing-only for the
public endpoint.

**Processing** (worker, once the scan clears a file): text from PDFs (pdf.js), text files and
.docx/.pptx/.xlsx (their XML), stored in `document_contents` with a generated English `tsvector`;
thumbnails from images (sharp) and PDF first pages (pdf.js on @napi-rs/canvas); with Gotenberg, Office
files become PDFs for preview, thumbnails and text. Everything derived records the object it came
from, so a new version starts over and late results for an old object are discarded.

---

## 9. Sharing

- **Tokens** are 256-bit, prefixed (`shr_`, `fsh_`, `inv_`, …), stored as SHA-256, and redacted from
  logs and traces by pattern.
- **Unlock grants** are cookies per link: `v2.<expiry>.<email>.<password>.<hmac>` over the link id and
  the current password hash, so changing the password or removing an address invalidates them.
- **Restricted links** email a six-digit code (HMAC-hashed, only the newest valid, 5 tries, 10
  minutes, at most 3 per 15 minutes per address); the answer to "send me a code" never reveals
  whether the address is on the list.
- **View-only** links stream the file; PDFs are watermarked into every page with pdf-lib, and one that
  can't be stamped is refused rather than shown unmarked. Links with a download limit are never shown
  inline, so viewing can't bypass the limit.
- **Folder links** check every requested folder and file against the shared subtree in SQL.
- **Access events** go to a monthly-partitioned table; per-link counters are kept on the row so the
  document list reads them without scanning history.

---

## 10. Error model

One envelope: `{ "error": { "code": "…", "message": "…", "details"?: [...] } }`. The status table and
stable codes are in [`docs/04-api-spec.md`](docs/04-api-spec.md). Unknown errors become an opaque 500
with the request id; no stack traces, SQL or driver text ever reach a client.

---

## 11. Configuration

`apps/api/src/config.ts` validates API and worker configuration through Zod at boot. The web
server reads its own environment, and tracing also uses standard OpenTelemetry variables.
[`.env.example`](.env.example) documents local defaults; Compose supplies container hostnames and
the application database role. The example file is intended for Compose, not an unmodified host-run API.

| Group | Variables |
| --- | --- |
| Runtime | `NODE_ENV` `API_PORT` `WEB_URL` `TRUSTED_PROXIES` `ENABLE_HSTS` `SEED_DEMO_DATA` `EXPOSE_INVITE_LINKS` |
| Database | `DATABASE_URL` `DATABASE_DIRECT_URL` `DATABASE_READ_URL` `APP_DB_PASSWORD` `DB_POOL_MAX` `DB_STATEMENT_TIMEOUT_MS` `POSTGRES_*` |
| Sessions and accounts | `SESSION_COOKIE_NAME` `SESSION_TTL_DAYS` `SESSION_COOKIE_SECURE` `LOGIN_LOCKOUT_ATTEMPTS` `LOGIN_LOCKOUT_MINUTES` `PASSWORD_RESET_TTL_MINUTES` `EMAIL_VERIFICATION` |
| Email | `SMTP_URL` `MAIL_FROM` |
| Object storage | `S3_ENDPOINT` `S3_PUBLIC_ENDPOINT` `S3_BUCKET` `S3_REGION` `S3_ACCESS_KEY` `S3_SECRET_KEY` |
| Files | `MAX_UPLOAD_BYTES` `MAX_CONCURRENT_UPLOADS` `MAX_DIRECT_UPLOAD_BYTES` `UPLOAD_SESSION_TTL_HOURS` `UPLOAD_PART_URL_TTL_SECONDS` `SIGNED_URL_TTL_SECONDS` `TRASH_RETENTION_DAYS` `DOCUMENT_MAX_VERSIONS` `ARCHIVE_MAX_FILES` `ARCHIVE_MAX_BYTES` `MAX_CONCURRENT_ARCHIVES` |
| Scanning and processing | `SCAN_MODE` `SCAN_MAX_BYTES` `PROCESSING_MAX_BYTES` `OFFICE_PREVIEWS` |
| Sharing | `SHARE_DEFAULT_TTL_HOURS` `INVITE_TTL_HOURS` `IP_HASH_PEPPER` `SHARE_GRANT_SECRET` `SHARE_WATERMARK_MAX_BYTES` `SHARE_EVENT_RETENTION_MONTHS` |
| Platform | `RATE_LIMIT_STORE` `MAINTENANCE_INTERVAL_MINUTES` `NOTIFICATION_STREAM_HEARTBEAT_SECONDS` `WEBHOOK_ALLOW_INSECURE` `WEBHOOK_TIMEOUT_MS` |
| Observability | `METRICS_PORT` `OTEL_EXPORTER_OTLP_ENDPOINT` (and the standard `OTEL_*` variables) |
| Web container | `API_INTERNAL_URL` `STORAGE_PUBLIC_ORIGIN` `ENABLE_HSTS` |

---

## 12. Docker Compose

| Service | Notes |
| --- | --- |
| `postgres` | PostgreSQL 16, named volume, healthcheck |
| `minio` | named volume, healthcheck; console on 9001 |
| `mailpit` | catches every email; UI on 8025 |
| `migrate` | one-off: migrations, then the application role |
| `api` | Fastify on 4000; metrics on 9464 inside the network |
| `worker` | the job loop and the maintenance schedule; metrics on 9464 |
| `web` | Next.js standalone behind `server.mjs`, fixed address `10.203.14.10` (the only proxy the API trusts) |
| `clamav` (*antivirus*) · `gotenberg` (*office*) · `prometheus`, `jaeger` (*observability*) · `pgbouncer` (*pgbouncer*) | optional profiles |

Application images run as the unprivileged `node` user, carry no compilers and no npm, and every base
image is pinned by digest. Seed data (development only, idempotent): two demo users, a shared
workspace, documents, a live link and a pending invitation.

---

## 13. Observability

- **Logs**: pino, a request id on every line, a trace and span id when tracing is on, and redaction of
  cookies, authorization headers, passwords and every token pattern.
- **Metrics** (`:9464/metrics`, API and worker): request duration by route template and status,
  requests in flight, job duration by queue and outcome, queue depth, database pool usage, webhook
  outcomes, Node process metrics.
- **Traces** (with `OTEL_EXPORTER_OTLP_ENDPOINT`): HTTP, Fastify and PostgreSQL spans (statements with
  placeholders, never values), redacted before export.
- **Health**: `GET /health` (liveness, used by Compose) and `GET /ready` (the database answers).

---

## 14. Out of scope

OAuth, SSO and MFA; billing; real-time co-editing; account deletion; a separate search engine;
microservices, Redis, Kafka, Kubernetes, any ORM. Each is a decision rather than an omission: the
README's trade-offs section says what would change the answer.

---

## 15. ADR index

| # | Decision |
| --- | --- |
| 001 | Fastify + Zod for the API (Zod now also generates the OpenAPI document) |
| 002 | Raw `pg` with parameterised SQL, no ORM |
| 003 | Ordered `.sql` migrations with a small runner |
| 004 | Every document belongs to a workspace; register auto-creates one |
| 005 | OWNER and MEMBER (VIEWER added later) |
| 006 | Share links are DB rows with hashed tokens, never long-lived signed URLs |
| 007 | Object written before the row (bytes later moved to direct uploads: ADR-013) |
| 008 | Soft-delete the row, then delete the object after the trash window |
| 009 | Next.js as UI only, with a rewrite proxy to the API |
| 010 | 404 for non-members, 403 for insufficient role, 410 for dead share links |
| 011 | A job queue in PostgreSQL, enqueued in the caller's transaction |
| 012 | Row-level security as a second line, and a least-privilege application role |
| 013 | Direct, resumable multipart uploads to storage |
| 014 | A hash-chained audit trail |
| 015 | Full-text search in PostgreSQL, extracted by the worker |
| 016 | Webhooks behind an address check in the connection's own DNS lookup |
| 017 | One contract (Zod) for validation, OpenAPI, web types and the route reference |

Full records: [`docs/adr/README.md`](docs/adr/README.md)


## 16. Maintaining the API contract

After changing contract schemas or routes, regenerate the committed artifacts from the repository root:

```bash
npm --prefix apps/api run openapi
npm --prefix apps/api run docs:api
npm --prefix apps/web run api:types
```

The contract tests check route coverage, response schemas and generated-document drift. CI separately
checks generated web types. Run the API suite with PostgreSQL and MinIO available, following the
README, then run `npm run typecheck` for both applications.

## 17. Operational boundaries

The default Compose deployment is a local development setup. Production requires deployment-specific
HTTPS, secure session cookies, replacement of development credentials and signing secrets, and
disabling demo seeding and exposed invitation links. Enable ClamAV when malware scanning is required;
the default does not scan uploads. Configure SMTP for delivery outside Mailpit.

Back up PostgreSQL and object storage together, and verify restores before relying on them. Metadata
alone cannot recover document bytes. Job retries and hourly maintenance handle application cleanup;
they do not replace backups. Row-level security is additional protection for tenant-scoped reads:
public routes and workers still depend on explicit service authorization and query filters.
