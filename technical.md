# Technical Design — File Storage & Sharing

Status: **Implemented.** See [`README.md`](README.md) for how to run it.
Authority: this design follows **`file_storage_sharing_takehome_blueprint.pdf`** exactly — stack,
roles, schema, API shape, scope limits. Where the blueprint is silent, the choice is recorded in
[`docs/02-product-decisions.md`](docs/02-product-decisions.md).

Companion docs: [`docs/`](docs/) · ADRs: [`docs/adr/`](docs/adr/)

---

## 1. Goal

A small, functional full-stack application for document storage, external sharing, workspaces,
invitations and access control — **optimized for a weekend scope**.

`Browser → Next.js UI → Node.js API → PostgreSQL (metadata) + MinIO (file bytes)`

**Modular monolith.** No microservices, no Redis, no Kafka, no Elasticsearch, no Kubernetes.

---

## 2. Stack (as specified)

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | **Next.js + TypeScript + Tailwind** | Fast to build, functional UI, strong TypeScript support |
| Backend | **Node.js + TypeScript + Fastify** | Lightweight REST API with good validation and structure |
| Database | **PostgreSQL + `pg` (raw SQL)** | Explicit queries, strong SQL control, **no ORM** |
| Migrations | **Ordered `.sql` files + a small runner** | Meets the migration requirement without introducing an ORM |
| File storage | **MinIO locally via the S3 API** | Keeps bytes outside PostgreSQL; easy to swap for AWS S3 |
| Auth | **Email/password + server-side session cookie** | Simple browser auth with HttpOnly cookies |
| Testing | **Vitest + API/integration tests** | Effort aimed at authorization, sharing and storage boundaries |
| Infra | **Docker Compose** | One command brings up web, API, PostgreSQL and MinIO |

Supporting libraries, kept deliberately few: `@fastify/cookie`, `@fastify/multipart`,
`@fastify/rate-limit`, `@fastify/helmet`, `zod` (request validation), `@aws-sdk/client-s3` +
`s3-request-presigner`, `argon2`, `pino`.

Zod schemas are parsed explicitly inside each handler rather than through a type-provider plugin.
It is a few more lines per route, but it keeps the validation visible at the point of use and adds
no glue dependency — which matters for a codebase that has to be explained line by line.

### 2.1 Migrations: ordered SQL over node-pg-migrate

The blueprint allows either. **Chosen: numbered `.sql` files plus a ~50-line runner.**

```
apps/api/migrations/001_users_sessions.sql
                    002_workspaces_members.sql
                    003_documents.sql
                    004_shares.sql
                    005_invitations.sql
                    006_share_access_events.sql
                    007_audit_events.sql
                    008_notifications.sql
```

The runner opens a transaction, takes an advisory lock, reads applied versions from a
`schema_migrations` table, and executes the rest in filename order. It runs from the API entrypoint
before the server starts.

**Why:** the whole point of `pg` + raw SQL is that the schema is explicit and reviewable. Numbered
SQL files are the most explicit form of that — a reviewer reads the DDL directly, and every statement
is one I can defend in a walkthrough. `node-pg-migrate` would wrap the same SQL in a JS API and add a
dependency for nothing we need. Forward-only; no down-migrations (a weekend project doesn't roll back,
it re-creates).

---

## 3. Architecture

```
                     ┌──────────────────────────────────┐
 Browser (member)    │  web — Next.js (App Router)      │
 Browser (recipient) │  :3000                           │
                     │  next.config rewrites /api/* ────┼──┐  single origin,
                     └──────────────────────────────────┘  │  no CORS, cookies just work
                                                           │
                     ┌─────────────────────────────────────▼─┐
                     │  api — Fastify                  :4000 │
                     │  ┌─────────────────────────────────┐  │
                     │  │ routes    validate + delegate   │  │
                     │  │ ─────────────────────────────── │  │
                     │  │ service   domain, transactions  │  │
                     │  │ ─────────────────────────────── │  │
                     │  │ repo      parameterized SQL     │  │  ← the only SQL in the app
                     │  └─────────────────────────────────┘  │
                     │      FileStorage ◄────────────────────┼──┐
                     └───────────────┬───────────────────────┘  │
                                     │                          │
                  ┌──────────────────▼────────┐   ┌─────────────▼──────────────┐
                  │ PostgreSQL :5432          │   │ MinIO :9000 (console 9001) │
                  │ metadata only, no bytes   │   │ private bucket, file bytes │
                  └───────────────────────────┘   └────────────────────────────┘
```

Four compose services — `postgres`, `minio`, `api`, `web` — exactly as the blueprint specifies. The
bucket is created by the API at boot (`ensureBucket()`), so no fifth init container is needed.

**Bytes flow through the API.** `POST /api/workspaces/:id/documents` takes a multipart body and
writes it to MinIO; `GET /api/documents/:id/download` authorizes and then returns a short-lived
signed URL. This is the blueprint's flow, and it is the right one here: authorization is checked on
the same request that moves the bytes, and the `FileStorage` interface stays four honest methods
instead of leaking presigning semantics into the upload path.

The uploaded part is buffered in memory before being written. At a 25 MB cap that is a deliberate
trade: it is what allows the magic-byte check to run against the real content *before* anything is
written to storage, and it yields an exact size for the row. It would be the wrong call at
multi-gigabyte sizes, where streaming with a rolling prefix check is the answer.

---

## 4. Project layout (as specified)

```
.
├── docker-compose.yml
├── .env.example
├── README.md
├── technical.md
├── docs/
├── apps/
│   ├── web/                       # Next.js + TypeScript + Tailwind
│   │   └── src/app/               # login, register, workspaces, documents, invite, s/[token]
│   └── api/
│       ├── migrations/            # 001_*.sql … ordered, forward-only
│       ├── tests/                 # Vitest: unit + integration
│       └── src/
│           ├── server.ts          # buildApp(deps) — pure, testable
│           ├── main.ts            # migrate → ensureBucket → listen
│           ├── config.ts          # env parsed by Zod once, fail-fast
│           ├── db/
│           │   ├── pool.ts        # pg Pool
│           │   ├── tx.ts          # withTransaction(fn)
│           │   └── migrate.ts     # the ordered-SQL runner
│           ├── modules/
│           │   ├── auth/          # routes, service, repo, sessions, password
│           │   ├── workspaces/    # routes, service, repo, members, invitations
│           │   ├── documents/     # routes, service, repo, upload/download
│           │   └── shares/        # routes, service, repo (+ the public token route)
│           ├── storage/
│           │   ├── file-storage.ts   # the interface
│           │   ├── s3-storage.ts     # MinIO / S3
│           │   └── keys.ts           # the ONLY place object keys are built
│           ├── plugins/           # session, errors, rate-limit, logging
│           └── lib/               # tokens, errors, mime allowlist, logger redaction
```

**Layering rule:** a route may call a service; a service may call repos and `FileStorage`; nothing
calls upward. `pg` imports are legal only under `db/` and `*.repo.ts`; `@aws-sdk` imports only under
`storage/`. Enforced by an ESLint `no-restricted-imports` rule — which is how *"storage and auth
aren't tangled into request handlers"* stays true after the third feature.

---

## 5. Request lifecycle

```
request
  → helmet · cookie · rate-limit · pino (requestId, token redaction)
  → sessionPlugin        cookie → sha256 → SELECT session → req.user        | else 401
  → workspaceGuard       (routes under /workspaces/:id)
                         SELECT role FROM workspace_members → req.membership | else 404
  → Zod validation       params, query, body
  → route handler        requireOwner() where the action needs it            | else 403
                         → service (transaction boundary) → repo
  → error plugin         one envelope: { error: { code, message } }
```

Two deliberate properties:

1. **`workspaceGuard` is registered on the route prefix**, not opted into per handler — a document
   route cannot be written without the membership check running.
2. **Role checks are one helper**, not scattered `if`s. With only OWNER and MEMBER the rule set is
   small enough to read in one screen, which is exactly why the blueprint chose two roles.

---

## 6. Data access

`pg` `Pool`, parameterized queries, no query builder, no ORM.

```ts
// Every workspace-scoped read carries the tenant in the WHERE clause. Always.
const { rows } = await db.query(
  `SELECT id, filename, mime_type, size, uploaded_by, created_at
     FROM documents
    WHERE workspace_id = $1 AND deleted_at IS NULL
    ORDER BY created_at DESC`,
  [workspaceId],
);
```

- **Repositories take `workspaceId` first**: `findDocument(workspaceId, documentId)`. The object id
  alone is never sufficient to load a row — the structural defence against IDOR.
- **Every live-row query carries `deleted_at IS NULL`.** There is no ORM to do it for us, so it's a
  review checklist item and there's a test that soft-deletes a document and asserts it disappears
  from listing *and* download *and* share resolution.
- **Transactions** via `withTransaction(async (tx) => …)`, used wherever related rows must change
  together (accepting an invitation, registering a user with their first workspace).
- **Never string-interpolated SQL.** Parameterized only, everywhere, no exceptions.

---

## 7. Storage abstraction (as specified)

```ts
export interface FileStorage {
  upload(key: string, stream: Readable, contentType: string): Promise<void>;
  download(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresIn: number): Promise<string>;
}
```

One implementation ships: `S3Storage` against MinIO. Business logic never sees `PutObjectCommand` —
swapping to AWS S3 is an env change, and swapping to another provider is one new file.

Object keys are built in exactly one module:
```
workspaces/{workspaceId}/documents/{documentId}
```
Both UUIDs. **No user-controlled path segment**, so traversal via a crafted filename is impossible by
construction rather than sanitised away. The original filename lives in the `documents` row and is
re-attached at download time via `response-content-disposition`.

**Never make the bucket public.** The API asserts this at boot rather than assuming a default.

### The MinIO signing gotcha (documented up front because it costs everyone an hour)

Inside Compose the API reaches MinIO at `http://minio:9000`. The browser cannot resolve `minio`, and
an S3 signature covers the `Host` header — so you cannot string-replace the hostname, you get
`SignatureDoesNotMatch`. Fix: **two S3 clients**, one internal (`S3_ENDPOINT`, for upload/delete) and
one signing-only client built against `S3_PUBLIC_ENDPOINT` (`http://localhost:9000`, for URLs handed
to a browser), both `forcePathStyle: true`.

---

## 8. Upload flow (as specified)

```
POST /api/workspaces/:id/documents        multipart/form-data
  1. validate user        — sessionPlugin
  2. validate workspace   — workspaceGuard: caller is a member
  3. validate file        — size ≤ 25 MB (enforced by @fastify/multipart limits,
                            so an oversize body is aborted mid-stream, not buffered)
                          — MIME allowlist, checked against sniffed magic bytes,
                            not the client's declared header
  4. upload object        — storage.upload(key, stream, contentType)
  5. persist metadata     — INSERT INTO documents (...)
     └─ on failure: storage.delete(key) in a finally-guard, then rethrow
```

Step 5's cleanup is not incidental — it is one of the five tests the blueprint names: *"metadata is
not persisted when an object upload fails (and cleanup is attempted on partial failure)."*

**Object first, row second.** If the upload succeeds and the insert fails, we delete the object and
report failure — a brief orphan at worst, cleaned in the same request. The inverse order would leave
a row pointing at nothing, which is a user-facing 500 on every subsequent download.

Because the object is written before the row exists, there is **no `pending` status and no reaper
job** — a simplification the blueprint's flow buys us over a presigned-upload design.

---

## 9. Download flow (as specified)

```
GET /api/documents/:id/download
  1. authorize            — caller is a member of the document's workspace
  2. verify not deleted   — deleted_at IS NULL
  3. return               — 302 to a 60-second signed URL,
                            Content-Disposition: attachment; filename*=UTF-8''<name>
```

`GET /api/shares/:token` is the same shape with the token as the authorization instead of a session.

Signed URLs are minted per request and expire in 60 seconds. There is no durable object URL anywhere
in the system.

---

## 10. Error model

One envelope: `{ "error": { "code": "SHARE_EXPIRED", "message": "..." } }`

| Situation | Status |
| --- | --- |
| Not authenticated | 401 |
| Authenticated, **not a member** | **404** — 403 would confirm the workspace exists |
| Member, action needs OWNER | 403 |
| Share link revoked / expired | **410 Gone** — the link *was* real; tell the recipient to ask for a new one |
| Share token unknown | 404 |
| File too large | 413 |
| Unsupported MIME type | 415 |
| Rate limited | 429 |

Unhandled exceptions → opaque 500 with the request id. No stack traces, no SQL, no driver text.

---

## 11. Configuration

`config.ts` parses `process.env` through Zod **once at boot and exits on failure**. `process.env`
appears nowhere else. Every variable is in `.env.example` with a working local default.

```
NODE_ENV  API_PORT  WEB_URL  API_URL
DATABASE_URL
SESSION_COOKIE_NAME  SESSION_TTL_DAYS  SESSION_COOKIE_SECURE
S3_ENDPOINT  S3_PUBLIC_ENDPOINT  S3_BUCKET  S3_ACCESS_KEY  S3_SECRET_KEY  S3_REGION
MAX_UPLOAD_BYTES=26214400          # 25 MB
SHARE_DEFAULT_TTL_HOURS=168
INVITE_TTL_HOURS=168
SIGNED_URL_TTL_SECONDS=60
```

---

## 12. Docker Compose

`docker compose up --build` is the primary startup path.

| Service | Image / build | Port | Notes |
| --- | --- | --- | --- |
| `postgres` | `postgres:16-alpine` | 5432 | named volume; `pg_isready` healthcheck |
| `minio` | `minio/minio` | 9000 / 9001 | named volume; `/minio/health/live` healthcheck |
| `api` | build `apps/api` | 4000 | `depends_on: {postgres: healthy, minio: healthy}`; entrypoint runs migrations → `ensureBucket()` → seed (dev) → listen |
| `web` | build `apps/web` | 3000 | Next.js standalone build; rewrites `/api/*` → `api:4000` |

Seed data (dev only, idempotent): two demo users, a shared workspace, a couple of documents, a live
share link and a pending invitation — so a reviewer sees a working app immediately. Demo credentials
are printed in the README and on the login page.

URLs: UI `http://localhost:3000` · API `http://localhost:4000` · MinIO console `http://localhost:9001`.

---

## 13. Observability

- **Pino** structured logs, `requestId` on every line.
- A redaction serialiser strips `cookie`, `authorization`, `password`, and anything matching
  `shr_[A-Za-z0-9_-]+` / `inv_[A-Za-z0-9_-]+`. Tokens in logs are a real leak path and the cheapest
  one to close.
- `GET /health` (liveness) and `GET /ready` (DB + storage reachable) back the compose healthchecks.

---

## 14. Explicitly out of scope

Per the blueprint, and stated so the omissions read as decisions:

**Not built:** OAuth · SSO · MFA · billing · comments · document collaboration · **versioning** ·
search infrastructure · a component library or theming system. (In-app notifications were later
added on explicit request, overriding the blueprint's exclusion — see README §9.)
**Not introduced:** microservices · Redis · Kafka · Elasticsearch · Kubernetes · any ORM.

Also out of scope: workspace deletion, trash/restore, folders, quotas, and password-protected share links.
Member management, rename, preview, notifications and the audit trail were added later on request (README §9).

---

## 15. ADR index

| # | Decision |
| --- | --- |
| 001 | Fastify + Zod for the API |
| 002 | Raw `pg` with parameterized SQL, no ORM |
| 003 | Ordered `.sql` migrations with a small runner |
| 004 | Every document belongs to a workspace; register auto-creates one |
| 005 | OWNER and MEMBER only |
| 006 | Share links are DB rows with hashed tokens, never long-lived signed URLs |
| 007 | Bytes stream through the API; object written before the row, with cleanup on failure |
| 008 | Soft-delete the row, then delete the object |
| 009 | Next.js as UI only, with a rewrite proxy to the API |
| 010 | 404 for non-members, 403 for insufficient role, 410 for dead share links |

Full records: [`docs/adr/README.md`](docs/adr/README.md)
