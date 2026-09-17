# 05 — Security & Authorization

The blueprint's §7 lists nine controls. Each is below with how it's implemented, followed by the
three questions the original brief's rubric asks, and then what is **knowingly left out**.

---

## The blueprint's checklist

| Required | Implementation |
| --- | --- |
| Password hashing (Argon2/bcrypt) | **Argon2id**, OWASP-baseline parameters, per-password salt |
| HttpOnly + Secure cookies in production | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `NODE_ENV=production`, 7-day expiry |
| Server-side authorization on **every** workspace/document action | `requireSession` on each authenticated route → an explicit `workspaces.requireMember()` (or `authorizeById()` for id-addressed documents) in each handler → `requireOwner()` / `Permissions` where needed. Never a client-supplied role, never a claim in a token |
| Parameterized SQL | `pg` placeholders throughout; user input never reaches SQL text. The only interpolation into a query is a compile-time constant in `overview.service.ts`. Kept by review — there is no lint rule |
| Upload size validation | 25 MB enforced by `@fastify/multipart` limits — reading stops at the limit and the upload is rejected. An accepted file is buffered in memory (at most 25 MB) so its bytes can be checked |
| Upload type validation | MIME allowlist checked against **sniffed magic bytes**, not the client's declared `Content-Type` |
| Opaque random share/invitation tokens | `crypto.randomBytes(32)` → base64url, **256 bits** |
| Store token hashes, not raw tokens | `sha256(token)` in `bytea`, unique-indexed. Plaintext returned once at creation and never stored |
| **Never make the MinIO bucket public** | No read policy is ever applied, so the bucket keeps MinIO's private default (an anonymous request returns 403). The policy is **not** re-verified at boot. No credentials ever reach the browser |

---

## Rubric question 1 — Can one user reach another user's files?

**No, and there is one place to verify that.**

1. **One ownership model.** `documents.workspace_id` is `NOT NULL`; registration auto-creates a
   workspace. No nullable owner, no fallback branch, no second authorization path.
2. **Membership is checked explicitly in every handler.** Workspace-scoped routes call
   `workspaces.requireMember()`; there is no guard registered on a route prefix, so protection depends
   on each route making the call — and the cross-tenant suite checks that every route does.
3. **`DELETE /api/documents/:id` and `GET /api/documents/:id/download` are addressed without a
   workspace in the path** (as the blueprint specifies), so the service resolves the workspace *from
   the document row* and checks membership against it. These two routes get their own explicit tests,
   because the workspace comes from the row rather than the URL.
4. **Nothing is returned before authorization.** A document looked up by id is checked against the
   caller's membership of its own workspace before any data is returned or changed; listing queries
   carry `workspace_id` in the `WHERE` clause.

**Verification.** `tests/security/cross-tenant.test.ts` is table-driven: user B attempts every
document, share, member and invitation route against user A's resources. Expected **404**. Adding a
route without wiring the check breaks the suite.

**404 vs 403.** A non-member gets `404`, identical to a nonexistent id — `403` would confirm the
resource exists. A member lacking OWNER gets `403`, because they already know it exists.

## Rubric question 2 — Are share links guessable?

**No.**

| Property | Value |
| --- | --- |
| Entropy | `randomBytes(32)` → base64url = **256 bits** |
| Not a UUID | UUIDv4 is 122 bits and structured; a share token must be indistinguishable from noise and never confusable with an internal id |
| At rest | **`sha256(token)` only**, unique-indexed. A leaked backup or a read-only SQL injection yields no usable links |
| In transit | A path segment, not a query parameter — query strings leak into referrers and proxy logs |
| In logs | A Pino serialiser strips `shr_…` / `inv_…` before anything is written |
| Rate limit | 30/min per client IP on resolve, view and download. Brute force is already infeasible; this bounds automated probing. The client IP is taken from `X-Forwarded-For` only when the request comes from the trusted web proxy |
| Revocation | `revoked_at`, re-checked on **every** resolve, never cached |
| Expiry | 7-day default |
| Deleted document | The resolve query joins `documents` and requires `deleted_at IS NULL`, so deletion kills every link to it instantly |

A leaked link exposes one file's name, size, type and bytes — until it expires or is revoked. Not the
workspace, not the uploader, not the object key, not other documents.

## Rubric question 3 — Is the storage backend exposed?

**No.**

- The bucket is private: no read policy is ever applied, and an anonymous request returns 403. The
  policy is not actively re-verified at boot.
- No credentials reach the browser. The only thing a client receives is a signed URL for one key,
  valid for **60 seconds**.
- Object keys are server-generated UUID paths — `workspaces/{uuid}/documents/{uuid}` — with **no
  user-controlled segment**, so traversal via a crafted filename is impossible by construction rather
  than sanitised away. Keys never appear in any API response.
- MinIO's port is published for the browser's signed-URL download and the console only; a production
  note documents putting it behind TLS on a private network.

---

## Other controls

| Control | Implementation |
| --- | --- |
| Session revocation | Server-side rows. Deleting a membership or a session takes effect on the next request — the reason sessions beat JWTs here |
| Session fixation | A fresh row on every login; no client-supplied session id is ever honoured |
| CSRF | `SameSite=Lax` + JSON-only content type on mutations (forces a preflight) + same-origin via the Next.js rewrite |
| XSS via uploaded content | Downloads are served from the **MinIO origin, never the app origin**, always `Content-Disposition: attachment` with `X-Content-Type-Options: nosniff`. SVG is excluded from the allowlist |
| Headers | API: `@fastify/helmet`. Web (`apps/web/server.mjs`, on every page, asset and proxied call): CSP with `frame-ancestors 'none'`, `object-src 'none'`, same-origin scripts and connections; `X-Frame-Options: DENY`; `nosniff`; `Referrer-Policy: no-referrer`; `Permissions-Policy`; COOP; HSTS when `ENABLE_HSTS=true`. No `X-Powered-By` |
| Input validation | Zod on every param, query and body; unknown keys stripped |
| Enumeration | 404 for non-members; login and invite responses don't reveal whether an email has an account |
| Rate limiting | `@fastify/rate-limit` on register, login, invitations, uploads and every public share route; client address from `X-Forwarded-For` only when sent by the web container |
| Account lockout | 5 failures in 15 minutes lock the email from any address; unknown emails lock identically |
| Protected links | Argon2id password; 10 wrong tries in 15 minutes lock the link; HMAC-signed per-link unlock cookie, invalidated by a password change; atomic download limit |
| Offboarding | Removal or demotion to Viewer revokes that person's links in the workspace; notifications filtered by current membership |
| Upload memory | At most 4 uploads buffered at once (503 `UPLOADS_BUSY` before reading the body), so memory is bounded |
| Filename handling | Stored as data, rendered escaped by React, emitted only in `Content-Disposition` with RFC 5987 encoding |
| Visitor privacy | Share-link access is recorded as `sha256(pepper ‖ ip)` — never the raw address. Countable, not identifying. The public page discloses that access is visible to the sender |
| Secrets | Zod-validated at boot, fail-fast. `.env.example` ships dev-only values with a loud "change these" |
| Error leakage | Opaque 500s — no stack traces, no SQL, no driver text over the wire |

## Threat table

| Threat | Mitigation |
| --- | --- |
| IDOR on a document | Workspace-scoped queries; 404 for non-members; explicit tests on the two id-only routes |
| Privilege escalation | MEMBER calling an OWNER route → `requireOwner()`; role read from the DB per request |
| Invite forwarding | The invite is bound to an email; the accepting account's address must match |
| Share-link brute force | 256-bit tokens + rate limit |
| Link password guessing | Per-link lockout after 10 failures, independent of the guesser's address |
| Distributed password spraying on one account | Per-account lockout, independent of address |
| Leaked link after someone leaves | Their links are revoked when they are removed or demoted |
| Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY` on the web app |
| Token leak via Referer | `Referrer-Policy: no-referrer` |
| Memory exhaustion via parallel uploads | Concurrency slots + per-client upload rate limit |
| Storage DoS | 25 MB multipart limit aborts the stream; MIME allowlist |
| Orphaned object | Upload writes the object then the row, and deletes the object if the row fails |
| Dangling row | Delete writes the row then the bytes — never the reverse |
| Zombie access after removal | Server-side sessions; membership is re-read per request, so there is no stale-token window |
| Timing oracle on login | A dummy Argon2 verify runs even when the email is unknown |
| Token leak via logs | Redaction serialiser on `shr_`/`inv_` prefixes and on `cookie`/`authorization` |

---

## Knowingly left out

Stated plainly, because a take-home that claims to be secure everywhere isn't being honest.

1. **No virus/malware scanning.** A user can upload malware and share it. Real risk for this product;
   out of scope for a weekend, and the blueprint's §10 says keep scope tight.
2. **No email verification.** You can register with an address you don't own. Partly mitigated by
   invitations being email-bound.
3. **No 2FA / SSO / OAuth** — explicitly excluded by the blueprint.
4. **No CSRF double-submit token.** `SameSite=Lax` plus a JSON-only content type covers the realistic
   attacks; the token is the correct belt-and-braces addition and is deliberately omitted.
5. **No row-level security in Postgres.** Authorization is application-level through one guard path.
   RLS would be genuine defence-in-depth and is the first hardening step with more time.
6. **Cleanup is hourly, not immediate.** The maintenance job purges expired trash (retrying failed
   object deletions on the next run) and removes stale sessions, login failures, notifications and
   invitations. Access and audit events are never purged.
7. **The audit trail is append-only by convention, not enforcement.** The application never updates
   or deletes `audit_events`, but the database role could. Revoking `UPDATE`/`DELETE` for the app role,
   or hash-chaining entries, would make it tamper-evident.
8. **No TLS in the compose file.** Everything is HTTP on localhost; shipping self-signed certs would
   make the five-minute setup worse for no evaluation benefit.
9. **No account deletion / GDPR erasure flow.**
10. **Single-node assumptions.** Rate limiting is in-process; multi-replica would need shared state.
    Account and link lockouts are in Postgres and already work across instances.
11. **The CSP allows inline scripts**, because Next.js's bootstrap scripts are inline; a nonce would
    force every page to render dynamically.
