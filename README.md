# Vault — File Storage & Sharing

A small full-stack application for storing documents, organising them in workspaces with invited
colleagues, and sharing any document with someone outside the team through a link.

Two decisions shape everything else: **every document belongs to a workspace** (so there is exactly
one authorization path to get right), and **a share link is a database row holding a hashed token,
never a long-lived presigned S3 URL** (so it can be revoked, expired, killed the instant its document
is trashed — and, as of the product improvement below, *counted*).

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
7. Go to **Members**: invite any address as Owner, Member or **Viewer**, change roles, remove people,
   or cancel an invitation. The invitation URL appears on the page (no email provider is integrated —
   see §3).
8. Open the invite link in a private window and create an account: registering and joining happen in
   one transaction.
9. Back in **Documents**: create a **folder**, move a file into it, **search** the whole workspace, then
   **Move to trash** and restore it from the **Trash** tab.
10. In **Share**, tick **Require a password** and pick a **download limit**. Open the link privately:
    the file name stays hidden until the password is entered. **Edit** changes a live link's expiry.
11. Sign in as **bob** (a MEMBER) and confirm they cannot invite anyone or delete Alice's documents.

### Tests

```bash
docker compose up -d postgres minio
cd apps/api && npm install && npm test
```

`npm run test:unit` runs the container-free subset in about two seconds.

End-to-end browser tests run against the whole stack through port 3000:

```bash
docker compose up -d --build
cd e2e && npm install && npx playwright install chromium && npx playwright test
```

Run them against a freshly started API: the abuse tests use up the in-memory login rate limit for
your address (`docker compose restart api` resets it). CI (`.github/workflows/ci.yml`) runs all of
this on every push and pull request.

---

## 2. Architecture

```
Browser ──► Next.js (web, :3000) ──► Fastify (api, :4000) ──► PostgreSQL   (metadata)
                                                          └─► MinIO / S3  (file bytes)
```

Four containers: `postgres`, `minio`, `api`, `web`. A **modular monolith** — no microservices, no
Redis, no queue, no Kubernetes, and no ORM. Housekeeping (trash purge, expired sessions and so on)
runs inside the API on a timer, guarded by a Postgres advisory lock so only one instance does it.

The browser only ever talks to the web origin: Next.js proxies `/api/*` to the API container through
a rewrite. That makes the session cookie same-origin, so there is no CORS configuration anywhere in
the project — and no chance of getting it subtly wrong.

**Layering.** `route → service → repository`, with storage behind an interface:

```
apps/api/src/
  modules/{auth,workspaces,documents,folders,shares,
           audit,notifications,overview,maintenance}/   routes · service · repo per module
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
| Roles | OWNER and MEMBER, plus a read-only **VIEWER** added later on request (see below) |
| Share links | Read-only, optional expiry, creator can revoke, **recipient needs no account** |
| Invitations | By email; the recipient can create an account **or** sign in before accepting |
| Email in development | The generated invitation link is returned in the API response and logged, instead of integrating a mail provider |
| File limits | **25 MB**; common document and image types |
| Deletion | Soft-delete the metadata; deleted documents are not downloadable. The object is now kept for a 30-day trash window, then removed (added on request) |

### Decided where the brief was silent

**Every document belongs to a workspace, and registering creates one.** `documents.workspace_id` is
`NOT NULL`, and signing up creates *"My Workspace"* with an OWNER membership in the same transaction
as the user row. The alternative — a nullable owner, so files can exist outside a workspace — means
two authorization code paths, and cross-tenant bugs live in the branch you forgot. One model means
one question for any document: *is the caller a member of its workspace?*

**The permission model, in full** (all of it lives in `apps/api/src/policy.ts`):

| Action | OWNER | MEMBER | VIEWER |
| --- | :---: | :---: | :---: |
| List, search, preview, download documents; list members | ✅ | ✅ | ✅ |
| Upload, create folders | ✅ | ✅ | ❌ |
| Create a share link | ✅ | ✅ | ❌ |
| Rename, move, trash, restore a document | ✅ any | ✅ own only | ❌ |
| Rename, move, delete a folder | ✅ any | ✅ own only | ❌ |
| Edit or revoke a share link | ✅ any | ✅ own only | ❌ |
| Delete forever from the trash | ✅ | ❌ | ❌ |
| Invite, change roles, remove members, audit trail | ✅ | ❌ | ❌ |

**Losing access takes your links with it.** Removing a member, or demoting them to Viewer, revokes
every share link they created in that workspace in the same transaction. Otherwise a person who has
left could keep handing out documents through links that still work, and notifications about those
links would keep arriving for a workspace they can no longer see. Notifications are also filtered by
current membership when they are read, so older ones about a workspace you left disappear.

**Share links** are 256-bit random tokens (`crypto.randomBytes(32)`, base64url). Only
`sha256(token)` is stored, so the plaintext returned at creation is the only time it ever exists
outside the recipient's address bar — the UI says so. Default expiry is 7 days; 1 hour, 24 hours,
30 days and never are offered, and a live link's expiry can be edited. A link exposes one file's name,
size, type and bytes, and nothing else — not the workspace, not the uploader, not the object key.

**Protected links** (added on request) can also have:

- **A password**, hashed with Argon2id. Until it is entered the page shows nothing about the file,
  not even its name. A correct password sets an HttpOnly cookie for that one link, valid for an hour:
  `expiry.HMAC(secret, linkId.expiry.passwordHash)`. Changing the password invalidates every
  outstanding unlock. Ten wrong passwords in 15 minutes lock the link, from any address.
- **A download limit** (1–1000; 1 makes a one-time link). The count is claimed with one conditional
  `UPDATE … WHERE download_count < max_downloads RETURNING`, so two simultaneous downloads cannot both
  take the last one. A used-up link returns 410 and says so. Link-preview bots cannot use up downloads.

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

**Trash** keeps a deleted document's bytes for `TRASH_RETENTION_DAYS` (30). Trashing revokes the
document's share links in the same transaction, and **restoring does not bring them back** — a link
someone deliberately killed by deleting the file should not silently come back to life. The uploader or
an owner can restore; only an owner can delete forever. The maintenance job deletes the object first
and the row second, so a storage failure leaves a row it can retry rather than an orphaned object.

**Folders** are an adjacency list (`folders.parent_id`), at most 8 levels deep. Names are unique among
siblings, ignoring case, enforced by a unique index. Moves that would put a folder inside itself are
refused, and only empty folders can be deleted — no recursive delete that could take a hundred files
with it.

**Search and pagination are server-side.** Search matches file names anywhere in the workspace
(a `pg_trgm` index keeps `ILIKE '%term%'` fast), and lists use keyset pagination: the cursor holds the
last row's sort value and id, so pages never skip or repeat rows when documents are added meanwhile.
Sort columns come from a fixed whitelist of SQL fragments, never from the request.

### Not built, deliberately

OAuth, SSO, MFA, billing, comments, collaboration, versioning, content search, and a component
library or theming system — out of scope by instruction. Also absent: workspace deletion and quotas.

The specified route table and recommended architecture originally excluded member removal, role
changes, rename, notifications, trash, folders, search, protected links and the Viewer role. All were
**added later on explicit request** and are recorded as deliberate overrides, not as drift.

---

## 4. API overview

`/api` · JSON · session cookie auth · one error envelope `{ error: { code, message } }`.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/auth/register` | Create account (+ first workspace, + optional `inviteToken`) |
| POST | `/api/auth/login` | Create session (per-account lockout after 5 failures) |
| POST | `/api/auth/logout` | Destroy session |
| GET | `/api/auth/me` | Current user and their workspaces |
| POST | `/api/workspaces` | Create workspace |
| GET | `/api/workspaces` | List the caller's workspaces |
| GET | `/api/workspaces/:id/members` | List members (+ pending invitations, owner only) |
| POST | `/api/workspaces/:id/invitations` | Invite by email (owner only) |
| POST | `/api/workspaces/:id/documents` | Upload (multipart; `?folderId=`) |
| GET | `/api/workspaces/:id/documents` | List: `view`, `folderId`, `q`, `filter`, `sort`, `order`, `cursor`, `limit` |
| DELETE | `/api/documents/:id` | Move to trash (revokes its links) |
| POST | `/api/documents/:id/restore` | Restore from the trash |
| DELETE | `/api/documents/:id/permanent` | Delete forever (owner, trashed documents only) |
| GET | `/api/workspaces/:id/folders` | List folders |
| POST | `/api/workspaces/:id/folders` | Create folder |
| PATCH | `/api/workspaces/:id/folders/:folderId` | Rename or move folder |
| DELETE | `/api/workspaces/:id/folders/:folderId` | Delete an empty folder |
| GET | `/api/documents/:id/download` | Download (302 → 60-second signed URL) |
| GET | `/api/documents/:id/shares` | List a document's live links (never their tokens) |
| POST | `/api/shares` | Create share link (`expiresInHours`, `password`, `maxDownloads`) |
| PATCH | `/api/shares/:id` | Edit a link's expiry, password or download limit |
| DELETE | `/api/shares/:id` | Revoke share link |
| GET | `/api/shares/:id/events` | Access history for one link |
| GET | `/api/workspaces/:id/audit` | Workspace audit trail (owner only) |
| GET | `/api/workspaces/:id/overview` | Dashboard data, grouped by day in `?tz=` (activity slice owner only) |
| PATCH | `/api/workspaces/:id` | Rename workspace (owner) |
| PATCH | `/api/workspaces/:id/members/:userId` | Change role (owner; last owner protected) |
| DELETE | `/api/workspaces/:id/members/:userId` | Remove member (owner) or leave (self) |
| DELETE | `/api/workspaces/:id/invitations/:invitationId` | Cancel a pending invitation (owner) |
| PATCH | `/api/documents/:id` | Rename and/or move to a folder (uploader or owner) |
| GET | `/api/documents/:id/preview` | Inline preview — PDF and raster images only |
| GET | `/api/notifications` | The caller's notifications + unread count |
| POST | `/api/notifications/read` | Mark one (`{ id }`) or all as read |
| GET | `/api/shares/:token` | **Public** — resolve a link (metadata only, records nothing; no file name while locked) |
| POST | `/api/shares/:token/unlock` | **Public** — enter a link's password (10 per 15 minutes) |
| POST | `/api/shares/:token/view` | **Public** — page-view beacon sent by the recipient's browser |
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
service. Workspace-scoped routes check membership explicitly too — no route inherits a check from
its path — so the cross-tenant suite enumerates every route, including these two.

---

## 5. Data model

Six core tables, plus `sessions` (a server-side session cookie has to be stored somewhere) and the
tables later features needed.

```
users ──< sessions
  │
  ├──< workspace_members >── workspaces        PK (workspace_id, user_id) · role OWNER|MEMBER|VIEWER
  ├──< invitations >─────────┤                  email · token_hash · expires_at · accepted_at
  └──< documents >───────────┤                  workspace_id NOT NULL · folder_id · storage_key · deleted_at · deleted_by
          │            folders ┘                parent_id · name (unique per parent, case-insensitive)
          └──< shares                           token_hash · expires_at · revoked_at · password_hash · max_downloads · download_count
                  └──< share_access_events      ip_hash · user_agent · outcome   (see §9)

workspaces ──< audit_events     actor (nullable) · action · resource_id (no FK) · metadata jsonb
users      ──< notifications    type · title · body · read_at
login_failures                  email_hash · failed_at   (per-account lockout; no FK, so unknown emails lock too)
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

Later indexes: `documents (workspace_id, deleted_at DESC) WHERE deleted_at IS NOT NULL` for the trash,
a trigram GIN index on `filename` for search, and `(workspace_id, lower(filename), id)` and
`(workspace_id, size, id)` for the name and size sorts.

**Migrations** (001–014) are numbered `.sql` files in `apps/api/migrations/`, applied in order by a ~70-line
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

**Delete** goes the other way: soft-delete the row (and revoke its links) and commit. The document
becomes unreachable — from listing, download, and every share link pointing at it — at once. The bytes
stay for the 30-day trash window; purging removes the object first and the row second.

**Uploads are bounded in memory.** Each accepted file is buffered (up to 25 MB) so its magic bytes
can be checked before anything is written. At most `MAX_CONCURRENT_UPLOADS` (4) uploads are buffered
at once — the next gets `503 UPLOADS_BUSY` with `Retry-After: 5` before any of its body is read — and
each client is limited to 60 uploads a minute. Worst-case upload memory is 4 × 25 MB, not unbounded.

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
| SQL | Parameterised everywhere; user input never reaches SQL text. The only interpolations are fixed fragments chosen from a whitelist (sort columns, the file-type category expression) |
| Upload size | Enforced by the multipart parser, so an oversize body is cut off mid-stream |
| Upload type | Allowlist checked against sniffed magic bytes, not the declared header |
| Share / invite tokens | 256-bit, opaque, **stored as SHA-256**, redacted from logs by pattern |
| Bucket | Never public; no credentials reach the browser; downloads are 60-second signed URLs |
| Enumeration | 404 for non-members; identical response body for a wrong password and an unknown account |
| Login timing | A dummy Argon2 verify runs for unknown emails so latency does not reveal which addresses exist |
| Rate limiting | Per client IP on register, login, invitations, uploads and the public share routes; upload concurrency capped |
| Account lockout | 5 wrong passwords in 15 minutes lock that email address from **every** address (429 `ACCOUNT_LOCKED`); unknown emails lock identically, so lockout reveals nothing |
| Link passwords | Argon2id; 10 wrong attempts in 15 minutes lock the link; unlock cookie is per link, HMAC-signed, 1 hour |
| Client IP | `X-Forwarded-For` is believed only from the web container (`TRUSTED_PROXIES`); the web server overwrites any client-supplied value with the real socket address — see §10 |
| Headers | API: `helmet`. Web: CSP (`frame-ancestors 'none'`, `object-src 'none'`, scripts and connections same-origin), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` (tokens live in URLs), `Permissions-Policy`, COOP, and HSTS when `ENABLE_HSTS=true` behind TLS. No `X-Powered-By`. Downloads come from the MinIO origin with `Content-Disposition: attachment` |
| Status codes | Dead share links return a real **410**, unknown ones **404** — to browsers and crawlers, not just in the page text |
| Containers | Both run as the unprivileged `node` user; the API runtime image has no compilers; the web image is Next.js standalone output |

**Can one user reach another user's files?** No. One ownership model, membership checked explicitly
in every handler and resolved from the database per request, and documents addressed by id authorized
against their own workspace before anything is returned. `tests/security/cross-tenant.test.ts` asserts 404
across every document, share, member and invitation route.

**Are share links guessable?** No — 256 bits of entropy, hashed at rest, rate-limited, revocable,
expiring, optionally password-protected, and dead the moment their document is trashed or their creator
loses access.

**Is the storage backend exposed?** No — private bucket, server-generated UUID keys that never appear
in a response, and 60-second signed URLs minted per request.

### Knowingly left out

1. **No virus scanning.** A user can upload malware and share it. Real risk; out of scope for this
   scope of work.
2. **No email verification** — you can register with an address you do not own. Partly mitigated by
   invitations being email-bound.
3. **No CSRF double-submit token.** `SameSite=Lax` plus a JSON-only content type covers the realistic
   attacks; the token is the correct belt-and-braces addition and is deliberately omitted.
   The CSP allows inline scripts, because Next.js's bootstrap scripts are inline and a per-request
   nonce would disable static rendering; everything else is locked to the site's own origin.
4. **No row-level security.** Authorization is application-level through one path. RLS would be real
   defence-in-depth and is the first hardening step I would take.
5. **Cleanup runs hourly inside the API** (`MAINTENANCE_INTERVAL_MINUTES`; also `node dist/maintenance.js`
   for cron): purges trash older than 30 days, and deletes sessions expired over a day, login failures
   over a day old, read notifications after 30 days and all after 90, and invitations a week past
   expiry. Share access events and audit events are kept — they are the record.
6. **The audit trail is not tamper-evident.** It is append-only by convention (the application never
   updates or deletes it), not by database permission or hash-chaining. An operator with SQL access
   could edit it.
7. **No TLS locally**, no account deletion / GDPR erasure, and rate limiting is in-process, so its
   counters are per API instance and reset on restart. The account and link lockouts are in Postgres
   and are not.

---

## 8. Test strategy

**143 API tests — 13 unit, 77 integration, 53 security** — against a **real PostgreSQL and a real
MinIO**, plus **7 end-to-end browser tests** against the whole stack. Mocks would
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
| **Offboarding & Viewer** | Removing or demoting a member revokes their links in that workspace only; the removed person gets no further notifications and older ones disappear; a Viewer can read and download but gets 403 on upload, share, rename, move, trash and folders |
| **Protected links** | No file name before unlock; wrong password 401, tenth lock 429; a grant cookie for one link doesn't open another, and stops working when the password changes; a download limit of 1 allows exactly one of two concurrent downloads; bots can't use downloads; editing expiry and limits |
| **Lockout & capacity** | Five failures lock an account whatever address they come from; unknown emails behave identically; success clears the counter; a fifth concurrent upload gets 503 with `Retry-After` |
| **Trash, folders, search** | Trash revokes links, restore doesn't revive them, only owners purge, purge removes the object; retention job purges only expired items; folder name clash, cycle, depth and non-empty delete; search across folders with `%` and `_` treated literally; paging through every sort without skipping or repeating a row |

Client IP resolution has its own suite (`tests/security/client-ip.test.ts`): a spoofed
`X-Forwarded-For` is ignored from an untrusted sender and believed only from the configured proxy.

Expiry is tested by moving an injected clock, never by sleeping. The rate limiter is not registered
under `NODE_ENV=test` (every request in the suite comes from one address), so the per-address limits
are covered by the end-to-end suite instead.

**End-to-end** (`e2e/`, Playwright, Chromium) goes through port 3000 the way a browser does — the gap
that hid both defects in §10:

- the whole owner journey: sign up, upload, rename and create a folder in the in-app dialogs (a native
  `prompt`/`confirm` fails the test), share, an outsider opening the link twice with a forged
  `X-Forwarded-For` plus a Slack preview bot → exactly **1 open from ~1 viewer**, revoke → 410, trash
  and restore;
- a password-protected, one-download link from locked page to used up, and a real 404 for unknown links;
- security headers, and dialogs keeping keyboard focus inside and returning it on close;
- account lockout and the per-address login limit both holding when every request forges a new address.

**CI** runs API typecheck, build, tests and dependency audit; web typecheck, build and audit; then
builds the stack and runs the end-to-end suite, keeping container logs and the Playwright trace on
failure.

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
`resolved` · `downloaded` · `expired` · `revoked` · `document_deleted`. Written fire-and-forget so
telemetry failing can never stop a legitimate download.

**What counts as an open.** A view is recorded by a small request the share page sends *from the
recipient's browser* once it has loaded (`POST /api/shares/:token/view`); a download is recorded when
it happens. The server-side render of the page records nothing. Three rules keep the numbers honest:

- **Real addresses.** The browser request reaches the API through the web proxy with the visitor's
  address. The first version counted during the server-side render, where every visitor looked like
  the web container — three different people showed up as one viewer, so "someone else opened your
  link" and the forwarding warning never fired in practice. Tests had missed it because they called
  the API directly; it was caught by reproducing real traffic.
- **No refresh inflation.** Repeat views by the same visitor within 30 minutes count once.
- **No bots.** Link unfurlers (Slack, LinkedIn, WhatsApp) don't run JavaScript, so they never send
  the view request, and known crawler user agents are excluded from downloads too.

Views and downloads are counted separately, so opening a link and then downloading is one open and
one download, not two opens.

**Three things in the interface:**

1. **In the document list** — `2 links · 6 opens · last 3 minutes ago`, or `2 links · unopened`. The
   question is answerable without opening anything, via a lateral join that keeps it one query.
2. **In the share dialog** — per-link opens, downloads, estimated distinct viewers, first and last access, and an
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

#### Found in a pre-submission review

Before submitting, I went back over the finished system as a reviewer would: re-reading the brief's
three security questions and then **testing each claim against the running stack**, not the code.
That review found two defects in shipped, passing, "done" features. Both are fixed; both are worth
reading because the reason the tests missed them is the lesson.

<table>
<tr><th width="18%"></th><th width="41%">1 · Rate limits bypassable by a forged header</th><th width="41%">2 · Share-link viewer counts wrong in real use</th></tr>
<tr><td><b>What was wrong</b></td>
<td>The API trusted <code>X-Forwarded-For</code> from <i>any</i> sender (<code>trustProxy: true</code>), and its port is reachable directly. A client could claim a different IP on every request.</td>
<td>The public share page is rendered by the Next.js server, and the view was recorded during that render — where the API sees the <b>web container's</b> address, not the visitor's.</td></tr>
<tr><td><b>Impact</b></td>
<td>Per-IP limits on login, register, invitations and public share links never tripped, so password guessing was unthrottled. Viewer counts and the "may have been forwarded" warning could be faked.</td>
<td>Three different people showed as <b>one</b> viewer, so "someone else opened your link" and the forwarding warning never fired in a browser. Every refresh and every Slack/LinkedIn link preview also counted as an open.</td></tr>
<tr><td><b>How it was found</b></td>
<td>25 wrong-password logins from one address were blocked after 20. The same 25 with a made-up <code>X-Forwarded-For</code> on each were <b>never</b> blocked.</td>
<td>Opened the real share page as three clients: <code>distinct viewers: 1</code>. Downloads through the proxy counted correctly (3), which pinned the fault to the server render.</td></tr>
<tr><td><b>Why the tests missed it</b></td>
<td>The rate limiter is switched off under <code>NODE_ENV=test</code> (every test request shares one address), so no test exercised it at all.</td>
<td>The tests call the API directly with a chosen <code>X-Forwarded-For</code>. They proved the counting logic, but never went through the web server the way a browser does.</td></tr>
<tr><td><b>A second, hidden cause</b></td>
<td colspan="2">Fixing the API alone would not have been enough. Next.js only <i>adds</i> <code>X-Forwarded-For</code> when the header is absent (<code>??=</code> in its server), so a client-supplied value passes through the web tier to the API untouched. Found by reading Next's source before settling on a fix.</td></tr>
<tr><td><b>Fix</b></td>
<td>The API trusts the header only from a configured list (<code>TRUSTED_PROXIES</code>); Compose pins the web container to <code>10.203.14.10</code> and trusts only that. A small custom web server (<code>apps/web/server.mjs</code>) overwrites any client-supplied forwarding header with the real socket address before Next.js sees the request.</td>
<td>The server render records nothing. The page sends <code>POST /api/shares/:token/view</code> from the recipient's browser, so it carries their real address and is never sent by bots that don't run JavaScript. Repeat views within 30 minutes count once; crawler user agents are ignored; views and downloads are counted separately.</td></tr>
<tr><td><b>Verified by</b></td>
<td>Re-running the attack: now blocked after 20, both directly and through the web origin. <code>tests/security/client-ip.test.ts</code> covers trusted vs untrusted senders.</td>
<td>Three containers on distinct addresses, plus refreshes, a bot and a spoofing client: 4 opens, 1 download, 4 viewers, and the new-viewer and forwarding notifications fired. The same traffic previously gave 1 viewer. New tests cover render-not-counted, refresh de-duplication and bots.</td></tr>
</table>

**What I take from it.** Both bugs lived in the gap between the API and the web tier — exactly where
an API-level test suite can't see. The tests were green and the features "done"; only exercising the
system the way an attacker and a real recipient would exposed them. Both are now pinned by
end-to-end tests that go through the web server (§8), and those tests immediately caught one more
thing: every page was sending `X-Powered-By: Next.js`.

#### Found while building trash, folders and protected links

- **Switching to the Trash tab crashed the page.** For one render the previous tab's rows were drawn
  as trash rows, and a live document has no deletion date. Found by clicking through the new UI in a
  browser. The list now clears its rows when the query changes and ignores any response that arrives
  after a newer request.
- **Paging by date repeated rows.** The cursor carried the timestamp as a JavaScript `Date`, which
  keeps milliseconds, while Postgres stores microseconds, so the next page started slightly too early.
  The cursor now carries the sort value as Postgres text, untouched. Caught by the test that pages
  through every sort and checks each document appears exactly once.
- **The test clock leaked between tests**, so a test that moved time 31 days forward made later tests
  see expired sessions. The clock is now reset with the database.

#### During the build

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

- **End-to-end tests need a fresh API process**, because the rate limiter keeps its counters in memory.
  A shared store (Postgres or Redis) would fix that and make limits work across several instances.
- **Notifications poll every 20 seconds** while the tab is visible (and pause while it is hidden), so
  they are near-real-time, not instant. Server-sent events would be the upgrade if that ever matters.
- **The audit trail is append-only by convention, not enforcement.** A `REVOKE UPDATE, DELETE` on the
  table for the application role would make that real.
- **Bytes pass through the API**, and the uploaded part is buffered in memory so the magic-byte check
  can run before anything is written. Right at 25 MB, wrong at 5 GB — at that size the answer is
  streaming with a rolling prefix check, or presigned direct upload.
- **Raw SQL means two filters are my responsibility**, not the ORM's: `deleted_at IS NULL` on every
  live-row read, and `workspace_id` on every workspace-scoped read. Both are review checklist items,
  and the soft-delete test deliberately checks all three read paths because forgetting it in exactly
  one place is the realistic bug.
- **The trash retention job purges up to 100 documents per hourly run.** Fine at this scale; a very
  large backlog would take several hours to drain.
- **Next:** row-level security as defence-in-depth, virus scanning on upload, email delivery for
  invitations and notifications, and multipart upload above 25 MB.

Full design rationale, including the decisions considered and rejected, is in [`docs/`](docs/) and
[`technical.md`](technical.md).
