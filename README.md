# Vault — File Storage & Sharing

A small full-stack application for storing documents, organising them in workspaces with invited
colleagues, and sharing any document with someone outside the team through a link.

Two decisions shape everything else: **every document belongs to a workspace** (so there is exactly
one authorization path to get right), and **a share link is a database row holding a hashed token,
never a long-lived presigned S3 URL** (so it can be revoked, expired, killed the instant its document
is deleted — and, as of the product improvement below, *counted*).

---

## 1. Setup

Requires Docker. Nothing else — no local Node, Postgres or MinIO.

```bash
git clone <repo> && cd <repo>
cp .env.example .env
docker compose up --build
```

| | URL |
| --- | --- |
| Web UI | http://localhost:3000 |
| API | http://localhost:4000 |
| MinIO console | http://localhost:9001 (`minioadmin` / `minioadmin`) |

**Demo accounts** (seeded automatically, also shown on the sign-in page):

| Email | Password | |
| --- | --- | --- |
| `alice@example.com` | `password123` | owner of *My Workspace* and *Marketing* |
| `bob@example.com` | `password123` | member of *Marketing* |

Migrations and bucket creation run automatically when the API container starts. There is no manual
setup step.

### Try it in this order

1. Sign in as **alice** and open **Marketing**. You land on the **Overview** dashboard: totals, 14-day
   upload and link-open charts, storage by file type, most-viewed links and recent activity.
2. Go to **Documents** and **Upload** a PDF or image (25 MB max, several at once, or drag and drop).
   Click the eye icon to **preview** it inline.
3. Click **Share** on a row, create a link, and copy it.
4. Open that link in a **private window** — no account needed. That is the outsider's view.
5. Open **Share** on that document again — it now shows **how many times the link was opened and
   roughly how many people opened it**. Within 20 seconds the **bell** in the header tells you the
   link was opened. That is the product improvement (§9).
6. As alice (an owner), open **Activity** in the sidebar: the workspace's append-only audit trail.
7. Go to **Members**: invite anyone, change roles, remove people, or cancel an invitation. **Invite** and invite any address. The invitation URL appears on the page (no
   email provider is integrated — see §3).
8. Open the invite link in a private window and create an account: registering and joining happen in
   one transaction.
9. Sign in as **bob** (a MEMBER) and confirm he cannot invite anyone or delete Alice's documents.

### Tests

```bash
docker compose up -d postgres minio
cd apps/api && npm install && npm test
```

`npm run test:unit` runs the container-free subset in about two seconds.

---

## 2. Architecture

```
Browser ──► Next.js (web, :3000) ──► Fastify (api, :4000) ──► PostgreSQL   (metadata)
                                                          └─► MinIO / S3  (file bytes)
```

Four containers: `postgres`, `minio`, `api`, `web`. A **modular monolith** — no microservices, no
Redis, no queue, no Kubernetes, and no ORM.

The browser only ever talks to the web origin: Next.js proxies `/api/*` to the API container through
a rewrite. That makes the session cookie same-origin, so there is no CORS configuration anywhere in
the project — and no chance of getting it subtly wrong.

**Layering.** `route → service → repository`, with storage behind an interface:

```
apps/api/src/
  modules/{auth,workspaces,documents,shares}/   routes · service · repo per module
  storage/                                      FileStorage interface + S3 implementation
  db/                                           pg pool, transactions, migration runner
  policy.ts                                     the entire permission model
  plugins/                                      session, error envelope
```

Routes validate and delegate. Services own transactions. Repositories are the only place SQL lives,
and the only place `pg` is imported. Storage and auth never appear inside a request handler.

**Request path.** `session cookie → req.user` → `requireMember(workspaceId)` → `requireOwner()` where
the action needs it → handler. Membership is resolved from the database on every request, never from
a token claim, so removing someone takes effect on their very next call.

---

## 3. Product assumptions

The brief is deliberately incomplete. These are the calls made, split by whether they came from the
recommended architecture or were mine to make.

### Followed from the recommended architecture

| Area | Decision |
| --- | --- |
| Roles | **OWNER and MEMBER only** — small enough to reason about at a glance |
| Share links | Read-only, optional expiry, creator can revoke, **recipient needs no account** |
| Invitations | By email; the recipient can create an account **or** sign in before accepting |
| Email in development | The generated invitation link is returned in the API response and logged, instead of integrating a mail provider |
| File limits | **25 MB**; common document and image types |
| Deletion | Soft-delete the metadata, then remove the underlying object; deleted documents are not downloadable |

### Decided where the brief was silent

**Every document belongs to a workspace, and registering creates one.** `documents.workspace_id` is
`NOT NULL`, and signing up creates *"My Workspace"* with an OWNER membership in the same transaction
as the user row. The alternative — a nullable owner, so files can exist outside a workspace — means
two authorization code paths, and cross-tenant bugs live in the branch you forgot. One model means
one question for any document: *is the caller a member of its workspace?*

**The permission model, in full:**

| Action | OWNER | MEMBER |
| --- | :---: | :---: |
| List / download documents, list members | ✅ | ✅ |
| Upload | ✅ | ✅ |
| Create a share link | ✅ | ✅ |
| Delete a document | ✅ any | ✅ own only |
| Revoke a share link | ✅ any | ✅ own only |
| Invite a member | ✅ | ❌ |

**Share links** are 256-bit random tokens (`crypto.randomBytes(32)`, base64url). Only
`sha256(token)` is stored, so the plaintext returned at creation is the only time it ever exists
outside the recipient's address bar — the UI says so. Default expiry is 7 days; 1 hour, 24 hours,
30 days and never are offered. A link exposes one file's name, size, type and bytes, and nothing
else — not the workspace, not the uploader, not the object key.

**Invitations are bound to an email address.** The accepting account's address must match, otherwise
forwarding the link would be a privilege escalation. They are single-use and expire after 7 days,
and re-inviting the same address replaces the pending invitation rather than duplicating it.

**Allowed upload types** are PDF, Word, Excel, PowerPoint, text, CSV, Markdown, PNG, JPEG, GIF and
WebP — validated against **sniffed magic bytes**, not the client's declared `Content-Type`.
**SVG is excluded** because it is an executable document; archives are excluded because they hide
their contents from any future scanning.

**Status codes carry meaning.** A non-member gets **404**, identical to a resource that never
existed — a 403 would confirm it exists. A member lacking OWNER gets **403**, because they already
know it exists and the honest answer is more useful. A revoked or expired link gets **410 Gone**, not
404, so the recipient knows the link was genuine and can ask for a new one.

**Sessions are server-side rows**, not JWTs, because this application's entire job is granting and
revoking access: signing out, or losing membership, has to take effect immediately.

### Not built, deliberately

OAuth, SSO, MFA, billing, comments, collaboration, versioning, search infrastructure, and a component
library or theming system — out of scope by instruction. Also absent: workspace deletion, trash and
restore, folders, quotas, and password-protected links.

The specified route table originally excluded member removal, role changes and rename, and the
recommended architecture excluded notifications. All four were **added later on explicit request**
and are recorded as deliberate overrides in §9, not as drift.

---

## 4. API overview

`/api` · JSON · session cookie auth · one error envelope `{ error: { code, message } }`.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/auth/register` | Create account (+ first workspace, + optional `inviteToken`) |
| POST | `/api/auth/login` | Create session |
| POST | `/api/auth/logout` | Destroy session |
| GET | `/api/auth/me` | Current user and their workspaces |
| POST | `/api/workspaces` | Create workspace |
| GET | `/api/workspaces` | List the caller's workspaces |
| GET | `/api/workspaces/:id/members` | List members (+ pending invitations, owner only) |
| POST | `/api/workspaces/:id/invitations` | Invite by email (owner only) |
| POST | `/api/workspaces/:id/documents` | Upload (multipart) |
| GET | `/api/workspaces/:id/documents` | List documents |
| DELETE | `/api/documents/:id` | Delete document |
| GET | `/api/documents/:id/download` | Download (302 → 60-second signed URL) |
| GET | `/api/documents/:id/shares` | List a document's live links (never their tokens) |
| POST | `/api/shares` | Create share link |
| DELETE | `/api/shares/:id` | Revoke share link |
| GET | `/api/shares/:id/events` | Access history for one link |
| GET | `/api/workspaces/:id/audit` | Workspace audit trail (owner only) |
| GET | `/api/workspaces/:id/overview` | Dashboard data (activity slice owner only) |
| PATCH | `/api/workspaces/:id` | Rename workspace (owner) |
| PATCH | `/api/workspaces/:id/members/:userId` | Change role (owner; last owner protected) |
| DELETE | `/api/workspaces/:id/members/:userId` | Remove member (owner) or leave (self) |
| DELETE | `/api/workspaces/:id/invitations/:invitationId` | Cancel a pending invitation (owner) |
| PATCH | `/api/documents/:id` | Rename document (uploader or owner) |
| GET | `/api/documents/:id/preview` | Inline preview — PDF and raster images only |
| GET | `/api/notifications` | The caller's notifications + unread count |
| POST | `/api/notifications/read` | Mark one (`{ id }`) or all as read |
| GET | `/api/shares/:token` | **Public** — resolve a link (metadata only) |
| GET | `/api/shares/:token/download` | **Public** — download (302 → signed URL) |
| GET | `/api/invitations/:token` | **Public** — preview an invitation |
| POST | `/api/invitations/:token/accept` | Accept an invitation |

Several routes go beyond the specified table. The share-events, audit and notification routes
belong to the product improvement (§9); the rest exist because the specification requires the
behaviour elsewhere: the two document/share **download** routes (the storage section describes a download flow
its route table omits, and one route cannot return both JSON metadata and a redirect), the
invitation **preview** (the brief says an invited person may sign in *or* register before accepting,
which needs a page to land on), and the per-document **share list** so links can be revoked from the
UI.

Note that `DELETE /api/documents/:id` and its download route carry no workspace in the path. The
workspace is therefore read from the document row and membership checked against it, inside the
service — and those two routes get their own explicit cross-tenant tests, because they are the ones
that do not inherit the check from a route prefix.

---

## 5. Data model

Six tables, plus `sessions` (a server-side session cookie has to be stored somewhere).

```
users ──< sessions
  │
  ├──< workspace_members >── workspaces        PK (workspace_id, user_id)
  ├──< invitations >─────────┤                  email · token_hash · expires_at · accepted_at
  └──< documents >───────────┘                  workspace_id NOT NULL · storage_key · deleted_at
          └──< shares                           token_hash · expires_at · revoked_at
                  └──< share_access_events      ip_hash · user_agent · outcome   (see §9)

workspaces ──< audit_events     actor (nullable) · action · resource_id (no FK) · metadata jsonb
users      ──< notifications    type · title · body · read_at
```

`audit_events.resource_id` deliberately has **no foreign key**: an audit entry must outlive the thing
it describes, so the filename is snapshotted into `metadata` at write time.

Two constraints do real work:

- **`PRIMARY KEY (workspace_id, user_id)`** on `workspace_members` makes duplicate membership
  impossible at the database level rather than relying on an application check.
- **`documents.storage_key UNIQUE`** guarantees no two rows point at the same object, so deleting
  one document can never remove another's bytes.

Indexes: `documents (workspace_id, created_at DESC) WHERE deleted_at IS NULL` for listing,
`invitations (workspace_id, email) WHERE accepted_at IS NULL` so re-inviting replaces rather than
duplicates, unique indexes on every `token_hash` (which double as the lookup index), and
`workspace_members (user_id)` for "my workspaces".

Three operations are transactional because related rows must change together: **register** (user +
workspace + membership), **accept invitation** (membership + `accepted_at`), and **create
workspace**. Acceptance is a conditional `UPDATE … WHERE accepted_at IS NULL RETURNING`, so two
concurrent accepts cannot both succeed.

**Migrations** are numbered `.sql` files in `apps/api/migrations/`, applied in order by a ~70-line
runner (`src/db/migrate.ts`) that takes a Postgres advisory lock and records applied versions in
`schema_migrations`. Forward-only. Having chosen raw SQL for the application, hiding the schema
behind a migration DSL would have defeated the point.

---

## 6. Storage abstraction

```ts
interface FileStorage {
  upload(key, stream, contentType): Promise<void>;
  download(key): Promise<Readable>;
  delete(key): Promise<void>;
  getSignedUrl(key, expiresIn, options?): Promise<string>;
}
```

PostgreSQL stores metadata only; bytes live in MinIO. Business logic never imports the AWS SDK, so
swapping to real S3 is an environment change and swapping provider is one new file.

**Object keys** are `workspaces/{uuid}/documents/{uuid}`, built in exactly one module. No part of a
key comes from user input, so a filename like `../../etc/passwd` cannot influence where an object
lands — traversal is impossible by construction rather than sanitised away. The original filename
lives in the database and is re-attached at download time via `Content-Disposition`.

**Upload** — validate user → validate workspace → validate file → write object → insert row. If the
insert fails, the object is deleted again, so a failed upload never leaves a half-created document.
The reverse order would leave a row pointing at bytes that do not exist, which is a 500 on every
later download.

**Delete** goes the other way: soft-delete the row, commit, *then* remove the object. The document
becomes unreachable — from listing, download, and every share link pointing at it — before the bytes
are touched.

**The MinIO signing detail worth knowing.** Inside Compose the API reaches MinIO at `minio:9000`, but
the browser cannot resolve that name, and an S3 signature covers the `Host` header — so rewriting the
hostname afterwards breaks the signature. The implementation therefore keeps **two S3 clients**: an
internal one for server-side operations, and a signing-only one built against the public endpoint for
every URL handed to a browser.

---

## 7. Security decisions

| Control | Implementation |
| --- | --- |
| Password hashing | Argon2id (`memoryCost` 19 MiB, `timeCost` 2) |
| Cookies | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `NODE_ENV=production` |
| Session tokens | 256-bit random, **stored as SHA-256**, revoked by deleting the row |
| Authorization | Server-side on every workspace and document action; role read from the database per request |
| SQL | Parameterised everywhere; no string-built SQL anywhere in the codebase |
| Upload size | Enforced by the multipart parser, so an oversize body is cut off mid-stream |
| Upload type | Allowlist checked against sniffed magic bytes, not the declared header |
| Share / invite tokens | 256-bit, opaque, **stored as SHA-256**, redacted from logs by pattern |
| Bucket | Never public; no credentials reach the browser; downloads are 60-second signed URLs |
| Enumeration | 404 for non-members; identical response body for a wrong password and an unknown account |
| Login timing | A dummy Argon2 verify runs for unknown emails so latency does not reveal which addresses exist |
| Rate limiting | Register, login, invitation creation, and the public share routes |
| Headers | `helmet`; downloads are served from the MinIO origin with `Content-Disposition: attachment` |

**Can one user reach another user's files?** No. One ownership model, tenant-scoped repository
queries, and membership resolved per request. `tests/security/cross-tenant.test.ts` asserts 404
across every document, share, member and invitation route.

**Are share links guessable?** No — 256 bits of entropy, hashed at rest, rate-limited, revocable,
expiring, and dead the moment their document is deleted.

**Is the storage backend exposed?** No — private bucket, server-generated UUID keys that never appear
in a response, and 60-second signed URLs minted per request.

### Knowingly left out

1. **No virus scanning.** A user can upload malware and share it. Real risk; out of scope for this
   scope of work.
2. **No email verification** — you can register with an address you do not own. Partly mitigated by
   invitations being email-bound.
3. **No CSRF double-submit token.** `SameSite=Lax` plus a JSON-only content type covers the realistic
   attacks; the token is the correct belt-and-braces addition and is deliberately omitted.
4. **No row-level security.** Authorization is application-level through one path. RLS would be real
   defence-in-depth and is the first hardening step I would take.
5. **No background cleanup.** If the object deletion after a soft delete fails, the key is logged at
   `error` level for manual cleanup. There is no reaper job.
6. **The audit trail is not tamper-evident.** It is append-only by convention (the application never
   updates or deletes it), not by database permission or hash-chaining. An operator with SQL access
   could edit it.
7. **No TLS locally**, no account deletion / GDPR erasure, and single-node assumptions (rate limiting
   is in-process).

---

## 8. Test strategy

**84 tests: 13 unit, 71 integration**, against a **real PostgreSQL and a real MinIO**. Mocks would
pass while production broke — a fake S3 happily "deletes" an object a real bucket keeps, and a fake
database does not enforce the composite primary key that is what actually prevents duplicate
membership. The cost is that `npm test` needs Docker; that trade is deliberate.

The suite is aimed at the five things whose failure would be an incident:

| Area | Covered by |
| --- | --- |
| **Authorization** | A non-member gets 404 on every route; a MEMBER gets 403 (not 404) on owner-only actions; a MEMBER cannot delete someone else's document |
| **Sharing** | Valid link resolves and downloads anonymously; revoked → 410; expired → 410; unknown → 404; deleting the document → 410; the stored value is a hash, not the token; no response leaks the storage key, workspace or uploader |
| **Uploads** | Valid upload stores object *and* row; 26 MB → 413; `.exe` → 415; an executable renamed to `.pdf` and declared as PDF → 415 |
| **Membership** | Accepting creates exactly one membership; accepting twice → 410 with still one row; a forwarded invite redeemed by another account → 409; register-with-invite joins in one transaction |
| **Storage** | Object upload fails → **no metadata persisted**; metadata insert fails → **the object is deleted again**; deleting a document removes the object from the bucket; a soft-deleted document vanishes from listing **and** download **and** share resolution |
| **Management** | A workspace can never lose its last owner — including when two owners demote each other concurrently; removal cuts access on the same session's next request while the documents stay; members cannot remove others or promote themselves; cancelled invitations stop resolving; rename never changes the storage key; preview is inline for PDF and refused (415) for sniffable text types |
| **Audit & notifications** | The document lifecycle is recorded; the trail survives the document being hard-deleted; anonymous access has a null actor; owner-only (outsider 404, member 403); the first open notifies the creator, a refreshing viewer does not re-notify, a third network triggers a forwarding warning; uploaders are not notified of their own upload; one user cannot mark another's notifications read |
| **Access visibility** | Opens and downloads are counted; distinct networks are counted separately; attempts on a revoked or deleted link are recorded as such; **the raw IP never reaches the database**; history is not readable by another workspace |

Expiry is tested by moving an injected clock, never by sleeping. Not tested: the rate limiter (it is
not registered under `NODE_ENV=test`, because every request in the suite comes from one address),
getters, response mapping, and React components.

---

## 9. Product improvement — *share-link access visibility* (built)

**The problem.** You send a contract to someone outside the company. Did they open it? When? Is the
link still live? Did they forward it? Before this, the honest answer was *no idea* — `shares` recorded
when a link was created and revoked, and nothing about use. A link opened forty times looked exactly
like one nobody ever clicked.

That uncertainty is why people fall back to email attachments, which is precisely the behaviour this
product exists to replace. **Sharing without visibility is sharing with anxiety.**

**Why this one.** Of the directions worth taking, this was the only one that is both the first
question a real user asks after sharing, and small enough to build properly rather than gesture at:
one table, one insert on a path that already existed, and one panel. Versioning, notifications and
search were all out of scope by instruction; folders and quotas are plumbing with no new insight.

### What shipped

**One table** (`share_access_events`): share id, timestamp, hashed IP, user agent, and an outcome of
`resolved` · `downloaded` · `expired` · `revoked` · `document_deleted`. One insert on the existing
public resolve/download path, written fire-and-forget so telemetry failing can never stop a legitimate
download.

**Three things in the interface:**

1. **In the document list** — `2 links · 6 opens · last 3 minutes ago`, or `2 links · unopened`. The
   question is answerable without opening anything, via a lateral join that keeps it one query.
2. **In the share dialog** — per-link opens, estimated distinct viewers, first and last access, and an
   expandable history showing each event with an opaque viewer marker.
3. **A forwarding signal** — three or more distinct networks on a link you sent to one person raises a
   warning with a one-click path to revoke and reissue. Attempts on an already-dead link are counted
   too, which is the other signal worth seeing.

### The privacy stance — the part that needed deciding, not defaulting

The person opening a link **is not our user** and never agreed to be tracked. So:

- The raw IP address is **never stored** — only `sha256(pepper ‖ ip)`. Enough to count distinct
  viewers, useless for identifying anyone. A test asserts the address never reaches the database.
- The sender sees **counts and coarse signals**, never an address and never a location. The history
  shows an 8-character hash prefix as a stable "same viewer" marker.
- **The public share page says so plainly**: *"The sender can see when this link is opened."*
- Events cascade away with the link and with the document.
- Viewer counts are **labelled approximate in the UI**, because they are: NAT merges two people into
  one, and a phone switching from wifi to mobile splits one person into two. Presenting an estimate as
  a fact would be worse than admitting it.

The feature is link hygiene, not surveillance, and the data model is shaped so the surveillance
version is *harder* to build, not easier.

### Notifications and the audit trail

Both were added on request after the first build, and **notifications override the recommended
architecture's exclusion list** — a deliberate, recorded decision rather than drift.

**Notifications are in-app, not email.** There is no mail provider, and a notification waiting in the
product beats one that needs infrastructure to exist. Delivery is a 20-second poll, not websockets:
two index-backed queries are far cheaper than connection management in a single-process monolith.
Sent when:

- your link is **opened for the first time**, or by a **genuinely new viewer** — never on a refresh,
  because notifications that fire on every reload get ignored;
- a link reaches **three distinct networks** (forwarding warning);
- someone **uploads** to a workspace you're in (never the uploader themselves);
- someone **joins** a workspace you're in.

**The audit trail** (`audit_events`) records workspace creation, uploads, downloads, deletions, share
creation/revocation/access/blocked-attempts, invitations and joins. Two design points:

- **Mutations are awaited, and written inside the same transaction** where one exists (a join and its
  audit row commit together). **High-volume reads** — downloads, anonymous share access — are
  fire-and-forget, because a failed log write must never block a document someone is entitled to.
  Under a database outage the trail can lose read events; it cannot lose mutations.
- **It is owner-only**, for the same reason pending invitations are: it contains every member's actions
  and the addresses of people invited who never joined.

One real bug surfaced by the tests: the workspace auto-created at **registration** wasn't audited —
only workspaces created through the API were. Every user's first workspace would have had a blank
history. Fixed by auditing inside the registration transaction.

### What was deliberately left

Email delivery and digests (no mail infrastructure), notification preferences/muting, and audit
export. Aggregation is computed per request rather than materialised — correct at this scale.

### MVP completion: dashboard, membership management, rename, preview

The last round closed the gaps a real team would hit in the first week:

- **Overview dashboard** — totals, 14-day upload and link-open charts, storage by type, most-viewed
  links, recent documents and (for owners) recent activity, served by one endpoint. The two activity
  series are **separate charts rather than one dual-axis chart**, because uploads and link opens move
  on very different scales. Charts are hand-written SVG with hover tooltips and a table view; the
  six file-type colours were validated as an ordered set for colour-vision deficiency, and because
  three sit below 3:1 contrast on white, every segment is also labelled with its name and value.
- **Membership management** — change roles, remove members, leave, cancel invitations. The one
  invariant is *a workspace always has an owner*, enforced under a `SELECT … FOR UPDATE` row lock so
  two owners demoting each other simultaneously cannot both succeed. A test fires exactly that race.
  A removed member's documents stay: they belong to the workspace, which is the point of one.
- **Rename** documents and workspaces. A rename changes display metadata only — object keys are UUIDs,
  so it can never move or overwrite bytes.
- **Inline preview** for PDFs and raster images. Downloads stay forced to `attachment`; preview is the
  one deliberate exception and is refused for anything a browser might sniff into script (text, CSV,
  Markdown). The file still comes from the MinIO origin, never the app origin.
- **UI** — icon navigation (lucide), a workspace switcher, a mobile drawer, list/grid views,
  filters (all / shared / mine), multi-file upload, per-row action menus, and an activity timeline
  grouped by day with pagination.

## 10. Agent usage

Built with **Claude Code (Opus)**. The split was: I owned the decisions, the agent owned the typing.

**Decided by me, written down before any code existed** — the design documents in
[`docs/`](docs/) were produced first and acted as the specification the agent was held to: the
ownership model, the permission matrix, share-link semantics (entropy, hashing, expiry, revocation),
the upload/delete ordering and its failure paths, error-code semantics, the layering rule, and which
tests matter. **Delegated:** SQL migrations from the specified schema, route handlers and validation
schemas, repository plumbing, React components, Docker wiring, and test scaffolding from cases I
enumerated.

The principle throughout: an agent is fast at what has already been decided and confidently wrong at
what has not. Anything security- or product-shaped was settled in writing first.

### What went wrong, and how it was caught

- **Rate limiting throttled the test suite.** The first full run failed with five `429`s — every
  request in the suite comes from the same address, so `10 registrations/hour` fired immediately.
  Caught by running the tests. Fixed by not registering the limiter under `NODE_ENV=test`, and by
  writing down in the test strategy that the limits are therefore unverified — rather than quietly
  raising them and implying coverage that does not exist.

- **A test of mine was wrong, not the code.** "Rejects an expired invitation" expected `410` and got
  `401`. The invite TTL and the session TTL are both 7 days, so advancing the clock past the invite
  expiry also expired the session. The code was right; the test was asserting two rules at once. It
  now signs in again after moving the clock, so it tests the invitation rule alone.

- **Body validation ran before the authorization check.** In the invite route the agent parsed the
  request body first, so a non-member sending a malformed body got `400` while one sending a valid
  body got `404`. Not a leak — the 400 is returned regardless of membership — but the ordering is
  wrong on principle, and I found it while probing cross-tenant responses by hand rather than through
  a test. Authorization now runs first.

- **`max-w-0` collapsed the document table's filename column** to "No…". Tailwind's truncation idiom
  needs the constraint on an inner element, not the `<td>`. Only visible by actually opening the app
  — no test would have caught it.

- **The web container proxied to `localhost:4000` from inside Docker.** Next.js evaluates
  `rewrites()` at *build* time and bakes the result into the route manifest, so a runtime environment
  variable arrived too late. Fixed with a Docker build argument, and the reason is commented in both
  the Dockerfile and `next.config.mjs` so the next person does not re-derive it.

- **Rejected outright:** the agent's first storage design used presigned direct-to-MinIO uploads
  (browser uploads straight to the bucket). It is the better pattern at scale, but it contradicts the
  specified `FileStorage` interface, moves authorization off the request that carries the bytes, and
  needs bucket CORS. At a 25 MB cap the specified flow is simpler and easier to defend. I also cut
  an early four-role model back to OWNER/MEMBER for the same reason: a permission model you can print
  in eight rows is one you can actually review.

---

## 11. Trade-offs and future improvements

- **No VIEWER role.** A read-only contractor has to be trusted with upload rights. The first thing I
  would add — the schema needs one enum value and the policy file three lines.
- **No trash or restore.** Deletion removes the object right after the soft delete, so a mistaken
  delete cannot be undone. Keeping objects for a retention window is the next step.
- **Notifications poll every 20 seconds**, so they are near-real-time, not instant. Server-sent
  events would be the upgrade if that ever matters.
- **The audit trail is append-only by convention, not enforcement.** A `REVOKE UPDATE, DELETE` on the
  table for the application role would make that real.
- **Bytes pass through the API**, and the uploaded part is buffered in memory so the magic-byte check
  can run before anything is written. Right at 25 MB, wrong at 5 GB — at that size the answer is
  streaming with a rolling prefix check, or presigned direct upload.
- **No cleanup job** for an object whose deletion failed after its row was soft-deleted.
- **Raw SQL means two filters are my responsibility**, not the ORM's: `deleted_at IS NULL` on every
  live-row read, and `workspace_id` on every workspace-scoped read. Both are review checklist items,
  and the soft-delete test deliberately checks all three read paths because forgetting it in exactly
  one place is the realistic bug.
- **Next:** row-level security as defence-in-depth, virus scanning on upload, password-protected
  links, folders once a workspace passes a few dozen documents, and multipart upload above 25 MB.

Full design rationale, including the decisions considered and rejected, is in [`docs/`](docs/) and
[`technical.md`](technical.md).
