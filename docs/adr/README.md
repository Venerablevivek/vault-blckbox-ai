# Architecture Decision Records

Short, one decision each. **Context → Decision → Consequences.** These are the records I expect to be
asked about in the code walkthrough.

Where the blueprint dictates the choice, the ADR records *why it's a good choice* and what it costs —
because "the spec said so" is not an answer in a code walkthrough.

---

## ADR-001 — Fastify + Zod for the API

**Context.** The blueprint specifies Node.js + TypeScript + Fastify, *"lightweight REST API with good
validation and structure."*
**Decision.** Fastify 5, with Zod schemas parsed explicitly inside each handler.
**Consequences.** Validation is visible at the point of use, with no type-provider plugin to explain.
There is no generated OpenAPI document (`fastify-type-provider-zod` was planned and dropped).
Sessions are resolved by one global hook that only sets `req.user`; each authenticated route opts in
with `preHandler: requireSession`, and public routes don't. `@fastify/multipart` stops reading at the
25 MB limit; an accepted file is buffered in memory so its bytes can be sniffed.
**Trade-off.** Smaller ecosystem than Express, and authorization is opted into per route rather than
inherited, so a forgotten check is caught by the cross-tenant tests rather than by the framework.

## ADR-002 — Raw `pg` with parameterized SQL, no ORM

**Context.** The blueprint specifies PostgreSQL + `pg` (raw SQL): *"explicit queries, strong SQL
control, no ORM complexity."*
**Decision.** `pg` `Pool`, hand-written parameterized SQL in repository modules.
**Consequences.** Every query is visible and reviewable, which matters because authorization
correctness depends on exactly which `WHERE` clause ran. No generated client, no migration engine, no
query-builder semantics to explain. Six tables is well within the size where an ORM earns nothing.
**Trade-off, stated honestly.** Two responsibilities the ORM would have handled are now mine:
`deleted_at IS NULL` on every live-row query, and `workspace_id` in every workspace-scoped query.
Both are review checklist items with dedicated tests, and the soft-delete test deliberately checks
listing, download **and** share resolution — because forgetting the filter in exactly one place is
the realistic failure.

## ADR-003 — Ordered `.sql` migrations with a small runner

**Context.** The blueprint allows `node-pg-migrate` *or* a simple ordered SQL runner.
**Decision.** Numbered `.sql` files plus a ~50-line runner with a `schema_migrations` ledger and a
Postgres advisory lock, run from the API entrypoint.
**Consequences.** The schema is readable as DDL by anyone who opens the folder — consistent with
choosing raw SQL in the first place. Forward-only; no down-migrations, because a weekend project
re-creates rather than rolls back.
**Trade-off.** No scaffolding, no diffing, and nothing stops a hand-written migration from being
wrong — which is why migrations are reviewed as carefully as code.

## ADR-004 — Every document belongs to a workspace; register auto-creates one

**Context.** The original brief has a solo "upload a document" flow *and* a team workspace flow. The
blueprint's schema makes `documents.workspace_id` non-nullable.
**Decision.** Registration creates the user, a workspace named "My Workspace", and an OWNER
membership — in one transaction.
**Consequences.** One authorization question for any document: *is the caller a member of
`document.workspace_id`?* One function, one test suite. The cross-tenant bug class becomes hard to
write by accident.
**Trade-off.** A new user gets a workspace they didn't explicitly ask for.

## ADR-005 — OWNER and MEMBER only

**Context.** The blueprint: *"OWNER and MEMBER only. Keep authorization easy to reason about."*
**Consequences.** The entire permission model is eight rows and fits on one screen, which is what
makes it genuinely reviewable rather than nominally documented. The only OWNER-gated action is
inviting members; everything else is membership plus an ownership check on the row.
**Trade-off.** No read-only VIEWER, which is a real product need — a contractor who should see but
not upload has to be trusted with upload rights. Named in the README's trade-offs section rather
than quietly omitted.

## ADR-006 — Share links are DB rows with hashed tokens, never long-lived signed URLs

**Context.** The tempting shortcut is to make the share link *be* a 7-day signed S3 URL.
**Decision.** A `shares` row holding `sha256(token)` for a 256-bit token. A 60-second signed URL is
minted only *after* the row's rules pass.
**Consequences.** Links are revocable and expirable, the bucket stays private (the blueprint's own
rule), and the object key is never exposed. Deleting the document kills every link to it instantly,
because the resolve query joins `documents` and requires `deleted_at IS NULL`.
**Trade-off.** Two round-trips instead of one, and the API is in the path of every download decision
— though not of the bytes.

## ADR-007 — Bytes stream through the API; object written before the row

**Context.** The blueprint's `FileStorage` interface is `upload(key, stream, contentType)`, and its
upload flow is *validate → upload object → persist metadata*.
**Decision.** Multipart upload streamed straight into MinIO, then the row inserted; if the insert
fails, the object is deleted and the request fails.
**Consequences.** Authorization is checked on the same request that moves the bytes. No `pending`
status, no reaper job, no presigned-upload CORS configuration — a genuine simplification over a
direct-to-store design. Orphaned objects are impossible in the happy path and cleaned up in the
failure path.
**Trade-off.** A 25 MB upload occupies a Node connection for its duration, and the process is in the
data path. At this scale and this file-size cap, irrelevant; at 5 GB it would not be.

## ADR-008 — Soft-delete the row, then delete the object

**Context.** The blueprint: *"soft-delete document metadata, then remove the underlying object;
ensure deleted docs are not downloadable."*
**Decision.** `deleted_at = now()`, commit, then `storage.delete(key)`.
**Consequences.** Listing, download and share resolution all filter on `deleted_at IS NULL`, so the
document is unreachable the instant the transaction commits — before the bytes are gone. `storage_key`
is unique, so deleting one document can never remove another's bytes.
**Trade-off.** If the object delete fails, the key is logged at `error` level for manual cleanup.
There is no background reaper — out of scope, and said so rather than implied.

## ADR-009 — Next.js as UI only, with a rewrite proxy to the API

**Context.** The blueprint specifies Next.js for the frontend and a separate Node/Fastify API.
**Decision.** Next.js renders the UI and proxies `/api/*` to the API service via `next.config`
rewrites. No API routes, no server actions, no data access in the web app.
**Consequences.** Everything is same-origin, so the session cookie works with no CORS configuration
to get wrong — the single most common source of lost hours in this shape of project. The API stays
the one authorization boundary and could serve any other client tomorrow.
**Trade-off.** An extra network hop in development, and the web container must be able to reach the
API container by name.

## ADR-010 — 404 for non-members, 403 for insufficient role, 410 for dead share links

**Context.** Error semantics leak information, and dead share links are a user-experience question as
much as a security one.
**Decision.** Non-member → `404`, identical to a nonexistent resource. Member without OWNER → `403`.
Revoked / expired / deleted-document share → `410 Gone`. Unknown token → `404`.
**Consequences.** No existence oracle for outsiders; actionable errors for insiders; and a recipient
holding a dead link learns it *was* real and can ask for a new one, instead of doubting the URL.
**Trade-off.** Slightly confusing to debug — mitigated by logging the real reason server-side with
the request id.
