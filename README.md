# Vault — File Storage & Sharing

A full-stack application for storing documents, organising them in workspaces with invited
colleagues, and sharing them with people outside the team: a file or a whole folder, by link, with
the controls a real team needs (expiry, passwords, download limits, view-only, named recipients) and
the visibility it wants afterwards (who opened what, when).

Three decisions shape everything else:

- **Every document belongs to a workspace**, so there is exactly one authorization question for any
  document: *is the caller a member of its workspace?*
- **A share link is a database row holding a hashed token, never a long-lived presigned S3 URL**, so
  it can be revoked, expired, limited, locked to named people, and killed the instant its document
  is trashed or its creator loses access.
- **PostgreSQL is the only moving part besides object storage.** The job queue, rate limits, audit
  chain, full-text search, notification fan-out and live updates all run on it. No Redis, no
  Kafka, no Elasticsearch.

---

## 1. Setup

Requires Docker Engine or Docker Desktop with Docker Compose v2. The application runs entirely in
containers; running the test commands below also requires Node.js 22 and npm.

```bash
# Run from the cloned repository root.
cp .env.example .env
docker compose up --build --wait
```

| | URL |
| --- | --- |
| Web app | http://localhost:3000 |
| API (and its OpenAPI document at `/api/openapi.json`) | http://localhost:4000 |
| Mailpit, the email every flow sends | http://localhost:8025 |
| MinIO console | http://localhost:9001 (`minioadmin` / `minioadmin`) |

**Demo accounts**, seeded automatically and shown on the sign-in page:

| Email | Password | |
| --- | --- | --- |
| `alice@example.com` | `password123` | owner of *My Workspace* and *Marketing* |
| `bob@example.com` | `password123` | member of *Marketing* |

A one-off `migrate` container applies the migrations and sets up the application's database role
before the API and worker start. There is no manual step.

**Optional profiles** add services the core doesn't need:

| Profile | Adds | Turn on with |
| --- | --- | --- |
| `antivirus` | ClamAV: every upload is scanned before it can be downloaded or shared | `SCAN_MODE=clamav docker compose --profile antivirus up -d` |
| `office` | Gotenberg (LibreOffice): Office files get previews, thumbnails and search | `OFFICE_PREVIEWS=gotenberg docker compose --profile office up -d` |
| `observability` | Prometheus (http://localhost:9090) and Jaeger (http://localhost:16686) | `OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318 docker compose --profile observability up -d` |
| `pgbouncer` | Connection pooling in front of PostgreSQL | see `docker-compose.yml` |

To stop the stack while keeping files and database data, run `docker compose down`. To inspect a
startup failure, run `docker compose ps -a` and `docker compose logs migrate api worker web`.
Configuration defaults and optional limits are documented in [`.env.example`](.env.example).

### Try it in this order

1. Sign in as **alice** and open **Marketing**: the **Overview** dashboard shows totals, 14-day
   upload and link-open charts, storage by type, most-viewed links and recent activity.
2. In **Documents**, drag in a few files. They go straight to storage in parts (resumable, up to
   5 GB); PDFs and images get **thumbnails** a moment later. Switch to the grid view.
3. **Search** for a word that appears *inside* one of your PDFs: it finds the document and shows the
   matching passage. Press **⌘K** (Ctrl+K) for the command menu.
4. Tick a few documents: **download them as one zip**, move them, or send them to the trash
   together. Star one; open **Starred** and **Recent**.
5. Open a document's menu → **Versions** and upload a newer copy; restore the old one.
6. **Share** a PDF. Tick **Only specific people** (use any address) and **View only**, create the
   link, and open it in a private window: enter the address, fetch the code from Mailpit, and the
   PDF opens with your address **watermarked** into every page, with no download button.
7. Back as alice, open **Share** again: the link shows **who opened it and when**. The bell tells you
   within a second (server-sent events).
8. A folder's menu → **Share folder…** gives a link to the whole folder tree.
9. As an owner, open **Activity**: filter by person, kind or date, **export CSV**, and **verify
   integrity** of the hash-chained trail.
10. **Settings** → **Webhooks**, and **Account** → notification preferences, email digests and **API
    tokens**. The sidebar switches between the light, dark and system themes.
11. Sign in as **bob** (a member) and confirm they can't invite anyone or delete Alice's documents.

### Tests

```bash
docker compose up -d --wait postgres minio
npm --prefix apps/api ci
npm test
```

End-to-end browser tests run against the whole stack through port 3000:

```bash
docker compose up -d --build --wait
npm --prefix e2e ci
cd e2e
npx playwright install chromium
npx playwright test
```

The API harness creates `filesharing_test` and uses its own `vault_app_test` role; it resets test
data between cases. Connection overrides use `TEST_PG_*` and `TEST_S3_ENDPOINT` (see
[`harness.ts`](apps/api/tests/helpers/harness.ts)).

For source checks, install dependencies with `npm ci && npm run install:all`, then run
`npm run lint`, `npm run typecheck` and `npm run format:check` from the repository root.

The load test (k6, in Docker) and its results are in [`docs/11-performance.md`](docs/11-performance.md).
CI (`.github/workflows/ci.yml`) runs formatting, lint, typecheck, build, the API suite, dependency
audits, image scans and the end-to-end suite on every push and pull request.

---

## 2. Architecture

```
Browser ──► web (Next.js, :3000) ──► api (Fastify, :4000) ──┬─► PostgreSQL   metadata, queue, search, limits
                                                            └─► MinIO / S3   file bytes
                                     worker (same code) ────┬─► PostgreSQL
                                                            ├─► MinIO / S3
                                                            ├─► Mailpit / SMTP, webhooks
                                                            └─► ClamAV, Gotenberg (optional)
```

A **modular monolith** in two processes built from one codebase: the **API** answers requests, and
the **worker** does everything that shouldn't make a person wait (email, notification fan-out,
malware scans, thumbnails and text extraction, webhook deliveries, workspace purges, the hourly
maintenance pass). Any number of either can run.

Application API requests go through the web origin: Next.js proxies `/api/*` to the API, so the session
cookie is same-origin and there is no CORS configuration anywhere. File bytes go the other way round:
straight between the browser and object storage, through short-lived signed URLs.

**Layering.** `route → service → repository`, with storage behind an interface:

```
apps/api/src/
  contracts/        Zod schemas: request validation, response shapes, the OpenAPI document
  modules/          auth · workspaces · documents · folders · uploads · shares · folder-shares ·
                    audit · notifications · overview · tokens · webhooks · maintenance
                    (routes · service · repo per module)
  jobs/             the PostgreSQL job queue and its handlers
  processing/       text extraction, thumbnails, Office conversion (run by the worker)
  scanning/         the ClamAV client
  storage/          FileStorage interface + S3 implementation, object keys
  db/               pools, transactions, tenant scoping (RLS), migrations, the application role
  observability/    Prometheus metrics, OpenTelemetry tracing
  policy.ts         the entire permission model
```

Routes validate and delegate. Services own transactions. Repositories are the only place SQL lives.

**The job queue** is a table: a job is inserted in the same transaction as the change that needs it
(an upload and its scan job commit together, or neither does), workers claim jobs with
`FOR UPDATE SKIP LOCKED`, `LISTEN/NOTIFY` wakes them immediately, failures retry with backoff and end
in a dead-letter state, and a dedupe key collapses repeated work.

**Tenancy is enforced twice.** Every query filters by workspace in code, and PostgreSQL row-level
security narrows every multi-row read to the caller's workspaces as well. The application connects as
a least-privilege role that can't change the schema, can't bypass RLS, and can't edit the audit
trail.

---

## Assumptions and decisions

| Gap in the brief | Implemented choice and reason |
| --- | --- |
| Personal versus team files | Registration creates **My Workspace**. All documents use the same workspace membership rules, avoiding separate personal-file authorization. |
| File-level permissions | Members can read workspace files; owners manage any file and members manage their own. VIEWER provides read-only team access without per-file ACLs. |
| External recipients | A share needs no application account. Optional email codes restrict it to named recipients; tokens are stored hashed and returned once. |
| Link lifetime | Default expiry is seven days, with an explicit non-expiring option. A database-backed link can be revoked; an already-issued storage URL remains usable until its short expiry. |
| Invitations | Invitations expire after seven days and require a signed-in account matching the invited email. Acceptance and membership creation commit together. |
| Deletion | Trash retains bytes for 30 days and revokes links immediately. Restoring a file does not reactivate those links. |
| Accepted files | PDF, Office documents, text/CSV/Markdown and raster images; SVG and general archives are excluded. Types are checked against content. Direct uploads default to 5 GiB; buffered uploads and versions to 25 MiB. |
| Email in development | Mailpit captures real SMTP messages locally, so invitations, verification and reset flows can be exercised without an external provider. |
| Expanded scope | Versions, folders, VIEWER, notifications, search, audit integrity and optional scanning extend the original blueprint. This README and `technical.md` describe the current implementation; older design documents retain historical decisions. |

## 3. Features

| Area | What it does |
| --- | --- |
| Workspaces | Invite by email as Owner, Member or Viewer; change roles; remove or leave; a workspace always keeps an owner. Storage quota per workspace. Deleting a workspace removes everything |
| Documents | Direct, resumable uploads up to 5 GB; types checked against the bytes; duplicate detection; folders (8 levels); trash with 30-day restore; stars, recents; bulk move/trash/restore/delete; zip download of a selection or a folder tree |
| Versions | Upload a newer copy, keep history, download, restore or delete any version; the oldest are pruned past a limit |
| Processing | Malware scanning (ClamAV); thumbnails of images and PDFs; full-text search of PDFs, text and Office files; Office previews through Gotenberg |
| Sharing | Links to a file or a whole folder; expiry, password, download limits (one-time links), view-only with a burned-in watermark, and links restricted to named people who prove their address with an emailed code |
| Visibility | Opens, downloads and distinct viewers per link, who opened a restricted link, a forwarding warning, blocked attempts, full history as CSV |
| Activity | A hash-chained, tamper-evident audit trail with integrity verification; filters; CSV export |
| Notifications | In-app, live over server-sent events; per-type muting, instant email, daily or weekly digests |
| Accounts | Email verification, password reset, sessions list with sign-out, account lockout, API tokens (read-only or read-write) |
| Integrations | Signed webhooks with retries and a delivery log; an OpenAPI 3.1 document; API tokens |
| Interface | Dashboard with charts, list and grid views, a ⌘K command menu, light and dark themes, keyboard- and screen-reader-friendly (WCAG 2.1 AA checked automatically) |
| Operations | Prometheus metrics, OpenTelemetry tracing, a load test with thresholds, image scanning in CI |

### The permission model

All of it lives in `apps/api/src/policy.ts`:

| Action | OWNER | MEMBER | VIEWER |
| --- | :---: | :---: | :---: |
| List, search, preview, download documents and zips; list members | ✅ | ✅ | ✅ |
| Upload, create folders, upload versions of their own documents | ✅ | ✅ | ❌ |
| Create share links and folder links | ✅ | ✅ | ❌ |
| Rename, move, trash, restore, version a document | ✅ any | ✅ own only | ❌ |
| Rename, move, delete a folder | ✅ any | ✅ own only | ❌ |
| Edit or revoke a share link | ✅ any | ✅ own only | ❌ |
| Delete forever from the trash | ✅ | ❌ | ❌ |
| Invite, change roles, remove members, activity trail, webhooks, delete the workspace | ✅ | ❌ | ❌ |

**Losing access takes your links with it.** Removing a member, demoting them to Viewer, or deleting
the workspace revokes the share links and folder links they created, in the same transaction.

**Status codes carry meaning.** A non-member gets 404, identical to a resource that never existed; a
member without the role gets 403; a dead share link gets 410 so the recipient knows to ask for a new
one. Full conventions are in [`docs/04-api-spec.md`](docs/04-api-spec.md).

---

## 4. API overview

95 operations under `/api`, JSON, one error envelope `{ error: { code, message, details? } }`,
authenticated by a session cookie or an API token (`Authorization: Bearer vlt_...`). The contract is
defined once as Zod schemas; the OpenAPI document and the web app's types are generated from it, and
a contract test calls every route and checks every response against it.

| Group | Examples |
| --- | --- |
| Auth | register, sign in, password reset, email confirmation, sessions, API tokens |
| Workspaces & members | create, rename, delete; invite, change roles, remove; overview; storage |
| Documents | list/search/page, upload, rename/move, trash/restore/purge, bulk actions, zips, versions, stars, thumbnails, previews, downloads |
| Uploads | direct multipart uploads: start, sign parts, resume, complete, cancel |
| Sharing | document links and folder links: create, edit, revoke, access history (JSON and CSV) |
| Public | resolve and download links, passwords, one-time codes, view-only content, folder browsing and zips, invitations |
| Activity | the audit trail (filters, CSV, integrity check), notifications, live stream, preferences |
| Webhooks | create, edit, remove, test, delivery log |

The full route table is generated from the code: [`docs/04-api-spec.md`](docs/04-api-spec.md).

---

## 5. Data model

35 forward-only SQL migrations in `apps/api/migrations/`, applied by a small runner under an advisory
lock. The core:

```
users ──< sessions, api_tokens, notification_preferences
  │
  ├──< workspace_members >── workspaces            role OWNER|MEMBER|VIEWER · quota and usage
  ├──< invitations >──────────┤
  └──< documents >────────────┤                    workspace_id NOT NULL · folder_id · storage_key · version
          │  │ │    folders ──┘                    adjacency list, unique names per parent
          │  │ └──< document_versions              earlier versions, each with its own object
          │  └───── document_contents              extracted text + tsvector (search)
          ├──< shares ──< share_access_events      monthly partitions; ip hash, never the address
          │       └──< share_email_codes           one-time codes for restricted links
          └──< document_stars, document_recents

folders ──< folder_shares
workspaces ──< audit_events (hash-chained) · webhooks ──< webhook_deliveries
jobs · rate_limits · login_failures · uploads (multipart sessions)
```

Details, constraints and indexes are in [`docs/03-data-model.md`](docs/03-data-model.md).

---

## 6. Storage

```ts
interface FileStorage {
  upload(key, stream, contentType): Promise<void>;
  download(key): Promise<Readable>;
  delete(key): Promise<void>;
  getSignedUrl(key, expiresIn, options?): Promise<string>;
  copy?(sourceKey, targetKey): Promise<void>; // server-side where the store supports it
}
```

PostgreSQL stores metadata; bytes live in MinIO (or any S3). Business logic never imports the AWS SDK.

- **Object keys** are built only from server-generated UUIDs, in one module, so a file name can never
  influence where an object lands. The name lives in the database and returns through
  `Content-Disposition`.
- **Uploads go straight to storage** in 8 MiB parts through signed URLs, with the quota reserved up
  front and released if the upload is abandoned. The first bytes are checked against the declared
  type before the document exists. A smaller buffered endpoint (25 MB) serves API clients.
- **Every version, thumbnail and preview owns its own object**, so deleting one can never remove
  another's bytes, and purging a document removes all of them.
- **Zips are streamed** from storage one object at a time with an exact `Content-Length`; memory stays
  flat whatever their size.
- **Two S3 clients**: inside Compose the API reaches MinIO as `minio:9000`, which a browser can't
  resolve, and a signature covers the host, so browser-facing URLs are signed by a client built for
  the public endpoint.

---

## 7. Security

| Control | Implementation |
| --- | --- |
| Passwords | Argon2id; account lockout after 5 failures from any address; a dummy verify for unknown emails to reduce account-enumeration timing differences |
| Sessions | 256-bit random, stored as SHA-256, HttpOnly + SameSite=Lax + Secure in production, listed and revocable by the user |
| API tokens | `vlt_` + 256 bits, stored as SHA-256, read-only or read-write, optional expiry, emailed notice on creation, revoked by any password change, refused on account-security routes |
| Email | Addresses must be confirmed before sharing or inviting; notification emails and digests go only to confirmed addresses |
| Authorization | Checked on every request from the database; one policy module; tested on every route for every tenant boundary |
| Database | Parameterised SQL only; row-level security on every tenant table; the app's role can't alter the schema, bypass RLS, or update/delete the audit trail |
| Audit trail | Hash-chained per workspace; any edit, insertion or removal in the middle is detectable; the head hash can be recorded elsewhere |
| Uploads | Type allowlist checked against the bytes (no SVG, no archives); size and quota limits; malware scanning with ClamAV (optional profile) holds a file until it is clean |
| Share links | 256-bit tokens stored as SHA-256; passwords (Argon2id, per-link lockout); download limits claimed atomically; named recipients with emailed one-time codes (only the latest code works, 5 tries, 10 minutes); view-only content streamed and watermarked, never a URL to the original |
| Webhooks | https to public addresses only; the address check runs in the connection's own DNS lookup, so DNS rebinding can't reach internal networks or the cloud metadata address; no redirects; signed payloads (HMAC, timestamped) |
| Secrets in logs and traces | Every token pattern (sessions, links, invitations, resets, API tokens, webhook secrets) is redacted from logs and from exported trace spans |
| Rate limits | Per address, stored in PostgreSQL across instances, on every public and credential-sensitive route |
| Client address | `X-Forwarded-For` is believed only from the web container, which overwrites any client-supplied value |
| Headers | CSP, `frame-ancestors`, `nosniff`, `Referrer-Policy: no-referrer` (tokens live in URLs), Permissions-Policy, COOP, HSTS behind TLS; real 404/410 for dead links |
| Supply chain | Base images pinned by digest; npm removed from runtime images; dependency audits and Trivy image scans in CI; Dependabot |

**How are workspace files isolated?** Through one ownership model, membership checked on every
request, row-level security behind it, and a suite that asserts 404 across every route.

**How are share links protected?** 256 bits of randomness, hashed at rest, rate-limited, revocable, expiring,
optionally locked by a password or to named people, and dead the moment their document is trashed.

### Knowingly left out

1. **No CSRF double-submit token.** SameSite=Lax cookies plus JSON-only bodies cover the realistic
   attacks, and API tokens aren't sent by browsers. The token is the belt-and-braces addition.
2. **The CSP allows inline scripts**, because Next.js's bootstrap scripts are inline; everything else
   is locked to the site's own origin.
3. **View-only discourages copying; it can't prevent a screenshot.** The watermark names the viewer,
   which is the realistic deterrent, and the UI says so.
4. **No MFA or SSO**, no account deletion (GDPR erasure), and no TLS locally.

---

## 8. Tests

The API suite includes unit tests plus integration, security and contract tests against **real
PostgreSQL and MinIO**. Playwright browser tests exercise the whole stack. Mocks would pass while production broke: a fake S3 happily "deletes" an
object a real bucket keeps, and a fake database doesn't enforce the constraints, locks and row-level
security the design relies on.

| Suite | What it pins down |
| --- | --- |
| Contract | Every route is documented; every response matches its schema; the committed OpenAPI and route table are current |
| Security | Cross-tenant 404s on every route, the database role's privileges, row-level security, the audit hash chain, email verification, malware scanning, rate limits and lockouts, client IP trust, protected/view-only/restricted links, folder links, API tokens, the webhook address guard |
| Integration | Uploads (buffered and direct), quotas, trash, folders, search, versions, processing, zips and bulk actions, stars and recents, the job queue, notifications (live stream, preferences, digests), activity filters and exports, webhooks, metrics |
| Unit | Token and type handling, zip entry names, the SSRF guard, webhook signatures, the permission matrix |
| End-to-end | Every main journey through a real browser, including uploads resuming after a failure, a recipient opening a restricted view-only link with a code from Mailpit, folder links, versions, the command menu, themes, and **axe-core WCAG 2.1 AA checks** of every screen in both themes |

Time is moved with an injected clock, never by sleeping, and background work is awaited by polling
for its result, so the suite doesn't depend on how fast the machine is.

---

## 9. Performance

A k6 test runs browsing, searching, uploads and share-link opens together for three minutes. On one
laptop with everything in Docker: **165 requests/s with no errors**; p95 214 ms for listing, 204 ms
for full-text search, 381 ms for the dashboard, 291 ms for uploads and 98 ms for share links. Method
and analysis: [`docs/11-performance.md`](docs/11-performance.md).

---

## 10. Product improvement — share-link access visibility

**The problem.** You send a contract to someone outside the company. Did they open it? When? Did they
forward it? Without an answer people fall back to email attachments, which this product exists to
replace. Sharing without visibility is sharing with anxiety.

**What shipped** (and what later features built on): one row per access
(`share_access_events`, now partitioned by month), counted from the recipient's browser so the
address is real, with repeat views within 30 minutes counted once and link-preview bots excluded.
The document list shows `2 links · 6 opens · last 3 minutes ago`; the share panel shows opens,
downloads, approximate distinct viewers and the history; three distinct hashed client addresses on one link raises a
forwarding warning. Restricted links later added *who* opened them, and CSV export the full record.

**The privacy stance.** The person opening a link isn't our user and never agreed to be tracked. The
raw address is never stored (only a keyed hash, enough to count distinct viewers); the sender sees
counts and coarse signals, never an address or a location; the public page says plainly that the
sender can see when the link is opened; viewer counts are labelled approximate, because NAT and
changing networks make them so. The feature is link hygiene, not surveillance.

---

## 11. Agent usage

Built with **Claude Code**. The split: decisions were made and written down first (the design
documents in [`docs/`](docs/) were the specification the agent was held to), and the agent did the
typing. Anything security- or product-shaped was settled in writing before code existed.

### What went wrong, and how it was caught

The failures worth recording are the ones where the tests were green and the feature still wasn't
right, and how each was found.

- **Rate limits were bypassable with a forged `X-Forwarded-For`,** and **share-link viewer counts
  were wrong in real use** (every visitor looked like the web container). Both lived between the web
  tier and the API, where an API test can't see; found by attacking the running stack and by
  reproducing real traffic, and now pinned by end-to-end tests that go through the web server.
- **A row-level security policy failed on some connections,** because SQL doesn't promise to evaluate
  `OR` left to right, and a connection that had run a tenant transaction read the setting back as an
  empty string. Fixed with `NULLIF` before the cast.
- **A malware scan could vouch for a newer file.** A scan finishing after a new version was uploaded
  marked the new content clean. Scan results and checksums now apply only to the object they were
  computed from.
- **A quarantined file's bytes were given back to the quota twice** if it was later deleted for good.
  Found while writing the version purge path.
- **Digests could skip or repeat notifications** that shared a timestamp with the previous digest.
  Notifications are now marked when they go into a digest, by a query that returns exactly what it
  marked.
- **Running the API tests broke a running stack.** Database roles belong to the whole server, and the
  tests reset the password of the role the stack connects as. The tests now use their own role.
- **Tests that slept a fixed time for background work** failed about one run in six once
  notifications grew a preference lookup. They wait for the result instead; the suite was run
  repeatedly to confirm.
- **The automated accessibility checks** found secondary text below 4.5:1 contrast in both themes,
  an unlabelled file input, and a toggle pointing `aria-controls` at an element that didn't exist
  yet. The contrast values were then computed for every surface rather than picked by eye.

---

## 12. Trade-offs and future improvements

- **Search is PostgreSQL full-text search.** Right for this scale and one less system to run; a
  dedicated engine would add typo tolerance and relevance tuning.
- **Thumbnails and text are extracted in the worker's memory** (files up to 50 MB by default). Larger
  files are skipped rather than streamed.
- **The dashboard is computed per request.** It already reads from the replica pool; caching it for a
  few seconds per workspace is the next step if it gets hot (it is the slowest read under load).
- **Webhook secrets are stored as they are**, because signing needs them; encrypting them at rest
  with a key outside the database would be the next hardening step.
- **Raw SQL means the workspace filter is our responsibility**, not an ORM's; row-level security is
  the backstop, and the cross-tenant suite checks every route.
- **Next:** SSO and MFA, account deletion, encryption of secrets at rest, and caching for the
  dashboard.

Design rationale, including decisions considered and rejected, is in [`docs/`](docs/) and
[`technical.md`](technical.md).
