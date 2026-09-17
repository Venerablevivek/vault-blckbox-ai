# 08 — Implementation Plan

> **Historical.** This is the plan written before the build, kept as a record of the sequencing. The
> scope later grew on request (see [`00-index.md`](00-index.md#added-after-the-first-build)); the
> README describes the system as built.

Sequenced so the riskiest, most-graded thing is proven first, and every milestone leaves the repo in
a demoable state.

Total: **~12–15 focused hours.** Smaller than the previous plan because the blueprint cuts scope —
two roles instead of four, six tables instead of ten, no versioning, no design system.

---

## M0 — Skeleton that boots (1.5h)

- Workspace with `apps/api` and `apps/web`, TypeScript strict. *(Planned but not done: ESLint with a
  layering `no-restricted-imports` rule, and Prettier.)*
- `config.ts` (Zod-parsed env, fail-fast), Pino with the token-redaction serialiser
- Fastify app: helmet, cookie, rate-limit, the error envelope, `/health`, `/ready`
- `db/pool.ts`, `db/tx.ts`, **`db/migrate.ts`** — the ordered-SQL runner with an advisory lock
- `docker-compose.yml`: `postgres`, `minio`, `api`, `web` with healthchecks and `depends_on`
- API entrypoint: migrate → `ensureBucket()` → listen

**Done when:** `docker compose up --build` on a clean clone → `curl localhost:4000/health` is ok.
**Why first:** it's the primary startup path in the README. If it doesn't work, nothing else counts.

## M1 — Auth (2h)

- `001_users_sessions.sql`
- Argon2id; token generation (`randomBytes(32)` → base64url, `sha256` at rest)
- `POST /api/auth/register` · `login` · `logout` · `GET /api/auth/me`
- `sessionPlugin`; rate limits on register and login
- Register creates the user **and their first workspace and OWNER membership in one transaction**
- Tests: token entropy, password hashing, register → login → me → logout

## M2 — Workspaces & membership (2h)

- `002_workspaces_members.sql` — including the composite primary key that prevents duplicate membership
- `POST /api/workspaces` · `GET /api/workspaces` · `GET /api/workspaces/:id/members`
- Explicit `workspaces.requireMember()` in each handler *(planned as a prefix guard; not built that
  way)*; `requireOwner()` helper
- **`tests/security/cross-tenant.test.ts` starts here** and grows with every later milestone

**Why before documents:** the authorization skeleton must exist first, or documents get written
against a permissive baseline that has to be tightened later — and tightening later is how gaps
survive.

## M3 — Storage + documents (3h)

- `storage/file-storage.ts` (the blueprint's four-method interface), `s3-storage.ts` with the
  **dual-client** internal/public endpoint split, `keys.ts` as the only key constructor
- `003_documents.sql`
- `POST /api/workspaces/:id/documents` — multipart, 25 MB limit, MIME allowlist with magic-byte
  sniffing, **object first then row, with object cleanup if the row fails**
- `GET /api/workspaces/:id/documents` · `GET /api/documents/:id/download` (60s signed URL)
- `DELETE /api/documents/:id` — soft-delete, commit, then delete the object
- Tests: upload success, 413, 415, and **the storage-failure/cleanup pair**

**Riskiest milestone.** The MinIO signing/host interaction is where the hours disappear, so it's
front-loaded.

## M4 — Shares (2h)

- `004_shares.sql`
- `POST /api/shares` (one-time plaintext URL) · `DELETE /api/shares/:id` · `GET /api/shares/:token`
- Expiry, revocation, deleted-document check — all in the single resolve query
- Hard rate limit on the public route
- **`tests/security/shares.test.ts` in full**

**The most-graded feature in the original brief.** It gets its own milestone and its own test file.

## M5 — Invitations (1.5h)

- `005_invitations.sql` with the pending-unique partial index
- `POST /api/workspaces/:id/invitations` (OWNER only) — **returns `inviteUrl` in development**
- `GET /api/invitations/:token` preview · `POST /api/invitations/:token/accept`
- Email-match enforcement; accept-during-register in the same transaction
- `tests/integration/membership.test.ts`

## M6 — Web UI (3h)

- Next.js App Router, Tailwind, the `/api/*` rewrite to the API service
- `/login` `/register` `/workspaces/[id]` `/workspaces/[id]/members` `/invite/[token]` `/s/[token]`
- Upload with real progress; delete with confirmation; role-aware rendering
- The four states (loading / empty / error / forbidden) on every data view

**Budget discipline:** if this overruns, cut the workspace switcher before cutting any core flow.
Never cut `/s/[token]`.

## M7 — Seed, README, polish (2h)

- Idempotent dev seed: two demo users, a shared workspace, documents, a live share link, a pending
  invitation. Credentials printed in the README and on the login page
- `.env.example` complete and commented
- README in **the blueprint's §11 order**: Setup → Architecture → Product assumptions → API overview →
  Data model → Storage abstraction → Security decisions → Test strategy → Agent usage →
  Trade-offs / future improvements
- Final read-through: can I explain every line in an interview? Delete anything I can't

---

## Ordering rationale

1. **Compose first** — it's the primary startup path, and it fails loudly and late if deferred.
2. **Authorization before features** — features written under a permissive baseline stay permissive.
3. **Storage before sharing** — sharing is a thin capability layer over a working storage path.
4. **UI after the API is stable** — rewriting the UI against a churning contract is the classic time sink.
5. **README budgeted, not leftover** — it's graded as heavily as the code.

## Cut list, decided now rather than at 2am

1. Workspace switcher (one workspace per screen is fine)
2. Upload progress bar (a spinner works)
3. `GET /api/invitations/:token` preview (land straight on register)
4. Unit tests for pure helpers (the integration suite covers the behaviour)

**Never cut:** the cross-tenant tests, the share tests, the storage-failure test,
`docker compose up --build`, the README's assumptions section.

## Definition of done

- [ ] Clean clone → `cp .env.example .env && docker compose up --build` → working app
- [ ] Five flows work in a browser: register, upload, share externally, invite, accept
- [ ] `npm test` green, including all five blueprint test areas
- [ ] A non-member is refused by the API when calling directly, not just in the UI
- [ ] Deleting a document removes the object from MinIO and kills its share links
- [ ] README has all ten sections in the blueprint's order
- [ ] I can explain every file without reading it first
