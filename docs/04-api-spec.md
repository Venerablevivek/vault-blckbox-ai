# 04 — API Specification

The routes below are **exactly the blueprint's §6 table**, plus one route the blueprint's §5 requires
but its §6 table omits (marked ✚).

REST over JSON · session cookie auth · one error envelope:
`{ "error": { "code": "...", "message": "...", "details"?: [...] } }`

Requests are validated with Zod schemas parsed inside each handler. There is no generated OpenAPI
document: it would mean a type-provider plugin and a second way of declaring every route, for a
25-route API whose shape is fully described by this file.

---

## Auth

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Create session |
| POST | `/api/auth/logout` | Destroy session |
| GET | `/api/auth/me` | Current user |

- `register` — `{ email, password, inviteToken? }` → 201 + `Set-Cookie`. Creates the user, their
  first workspace and the OWNER membership **in one transaction**; consumes `inviteToken` in the
  same transaction when present.
- `login` — `{ email, password }` → 200 + `Set-Cookie`. Runs an Argon2 verify even for an unknown
  email, so response time isn't an oracle for which addresses exist.
- `logout` — deletes the session row; the cookie is cleared.
- `me` — `{ user: { id, email }, workspaces: [{ id, name, role }] }`. One call boots the UI.

Rate limited: register 5/hour/IP, login 10/15min/IP **and** 5/15min/email.

## Workspaces & members

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/workspaces` | Create workspace |
| GET | `/api/workspaces` | List user workspaces |
| GET | `/api/workspaces/:id/members` | List members |
| POST | `/api/workspaces/:id/invitations` | Invite member |

- `POST /api/workspaces` — `{ name }`; the creator becomes OWNER in the same transaction.
- `GET /api/workspaces` — only workspaces the caller is a member of, each with their own role.
- `GET /api/workspaces/:id/members` — any member. Returns `{ userId, email, role, createdAt }`.
- `POST /api/workspaces/:id/invitations` — **OWNER only**. `{ email, role }` → 201.
  **In development the response includes `inviteUrl`, and the URL is also logged** — per the
  blueprint's "expose the generated invitation link in development" decision. In production the field
  is omitted.

## Invitations (accepting)

| Method | Route | Purpose |
| --- | --- | --- |
| ✚ GET | `/api/invitations/:token` | Preview an invite (public) |
| ✚ POST | `/api/invitations/:token/accept` | Accept (authenticated) |

The blueprint's §3 states an invited person *"can create an account or sign in before accepting"* —
which requires a preview route (to render the landing page before auth) and an accept route. Both are
that decision made concrete.

Preview returns `{ workspaceName, email, expiresAt }` and nothing else. Accept returns `409` if the
signed-in account's email doesn't match the invited address.

## Documents

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/workspaces/:id/documents` | Upload document |
| GET | `/api/workspaces/:id/documents` | List documents |
| DELETE | `/api/documents/:id` | Delete document |
| ✚ GET | `/api/documents/:id/download` | Download document |
| ✚ GET | `/api/documents/:id/shares` | List a document's live links (never their tokens) |

- **Upload** — `multipart/form-data`, one `file` part. Enforces 25 MB via `@fastify/multipart`
  limits (the body is aborted mid-stream, never buffered) and the MIME allowlist against sniffed
  magic bytes. Streams to MinIO, then inserts the row; if the insert fails the object is deleted and
  the request fails, so **no metadata is persisted for a failed upload**.
  Returns `201 { id, filename, mimeType, size, uploadedBy, createdAt }`.
- **List** — live documents only, newest first. Any member. Each document carries a rollup of its
  live share links (`links: { count, opens, lastAccessedAt }`) via a lateral join, so the list can
  answer "has anyone opened this?" without a second request.
- **Delete** — the uploader or the workspace OWNER. Soft-deletes the row, commits, then deletes the
  object. `204`.
- **Download** ✚ — the blueprint's §5 specifies a download flow (*"authorize → verify not deleted →
  return a short-lived signed URL/stream"*) but §6 has no route for it. This is that flow:
  `302` to a 60-second signed URL with `Content-Disposition: attachment`.

Note that `DELETE` and `GET download` are addressed by document id **without** a workspace in the
path, exactly as the blueprint lists. The workspace is therefore resolved *from the document row* and
membership checked against it — the check is in the service, and the cross-tenant test suite covers
both of these routes specifically because they are the two that don't get it from the URL prefix.

## Shares

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/shares` | Create share link |
| DELETE | `/api/shares/:id` | Revoke share link |
| GET | `/api/shares/:token` | Resolve a shared file (metadata; records nothing) |
| ✚ POST | `/api/shares/:token/view` | Page-view beacon from the recipient's browser (204; 410/404 for dead/unknown links) |
| ✚ GET | `/api/shares/:token/download` | Download a shared file |
| ✚ GET | `/api/shares/:id/events` | Access history for one link (product improvement) |

The blueprint's table lists one route for "resolve/download". It is implemented as two, because the
landing page needs metadata as JSON while the download must be a redirect to a signed URL — one
route cannot be both. Both are public and both re-check every rule.

- **Create** — `{ documentId, expiresIn? }`. Caller must be a member of the document's workspace.
  Generates a 256-bit token, stores only `sha256(token)`, and returns
  `201 { id, url: "http://localhost:3000/s/<token>", expiresAt }`.
  **The plaintext token is returned exactly once and never again.**
- **Revoke** — creator or workspace OWNER. Sets `revoked_at`; effective on the next request. `204`.
- **Events** ✚ — any member of the document's workspace. Returns the last 20 accesses as
  `{ accessedAt, outcome, userAgent, viewer }`, where `viewer` is an 8-character prefix of the hashed
  address: a stable marker for "the same visitor", never an address. See
  [`09-product-improvement.md`](09-product-improvement.md).
- **Resolve / download** — **public, no session**. Hard rate-limited (20/min/IP). Checks
  `revoked_at`, `expires_at` and the document's `deleted_at` in one query. `?download=1` returns a
  `302` to a 60-second signed URL; without it, JSON metadata for the landing page:
  `{ filename, size, mimeType, expiresAt }`.

Never returned by any share route: the object key, the bucket, the workspace id, or the uploader's
identity.

---

## Audit & notifications ✚

| Method | Route | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/workspaces/:id/audit?limit&before` | owner (member 403, outsider 404) | Append-only activity feed |
| GET | `/api/notifications` | authenticated | `{ unread, notifications[] }` — polled every 20s |
| POST | `/api/notifications/read` | authenticated | `{ id? }` — one, or all when omitted |

## Status codes

| Situation | Status |
| --- | --- |
| Not authenticated | 401 |
| Authenticated, not a member of the workspace | **404** (403 would confirm it exists) |
| Member, action requires OWNER | 403 |
| Share revoked / expired / document deleted | **410 Gone** |
| Share token unknown | 404 |
| Duplicate membership, already-accepted invite | 409 |
| File over 25 MB | 413 |
| MIME type not allowed | 415 |
| Rate limited | 429 |

## Conventions

- Cookie auth only; no bearer tokens, no API keys.
- All mutations require `Content-Type: application/json` (except the multipart upload), which forces
  a preflight and blocks classic form-post CSRF.
- Responses never include `password_hash`, `token_hash`, or `storage_key`.
- The web app reaches the API through a Next.js rewrite, so everything is same-origin and there is no
  CORS configuration to get wrong.
