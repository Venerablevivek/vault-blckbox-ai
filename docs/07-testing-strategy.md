# 07 — Test Strategy

**Vitest + API/integration tests**, aimed — in the blueprint's words — at *"authorization, sharing,
and storage boundaries."* The original brief adds: *"aim them at the parts that would embarrass you
if they broke"*, and notes that coverage percentage is **not** graded.

---

## The five areas the blueprint names

| # | Area | Cases |
| --- | --- | --- |
| 1 | **Authorization** | Non-member cannot access another workspace or its documents |
| 2 | **Sharing** | A valid link works; expired / revoked / invalid links fail |
| 3 | **Uploads** | A valid upload succeeds; oversize and unsupported files are rejected |
| 4 | **Membership** | Duplicate membership is prevented; accepting an invitation creates exactly one membership |
| 5 | **Storage** | Metadata is not persisted when an object upload fails, and cleanup is attempted on partial failure |
| 7 | **Audit & notifications** | Lifecycle recorded, trail survives hard delete, owner-only, no refresh spam, forwarding warning, no self-notification, no cross-user read-marking |
| 6 | **Access visibility** | Opens are counted, distinct networks are distinguished, dead-link attempts are recorded, and the raw IP is never stored |

These five are the backbone of the suite. Everything else is secondary.

---

## Shape

```
 364 × API tests       unit, integration, security and contract (vitest), against a real
                       Postgres and a real MinIO (the containers `docker compose up` starts)
  34 × end-to-end      Playwright + Chromium against the whole stack through port 3000
                       (one is skipped unless malware scanning is on), incl. axe accessibility checks
       load test       k6, results in 11-performance.md
```

The contract test checks that every route is in the OpenAPI document, every documented operation
is exercised, responses match their schemas, and the generated route reference in `04-api-spec.md`
is current. Background work is awaited with polls, never fixed sleeps.

The original plan had no end-to-end browser tests, on the reasoning that an integration suite
through the real database catches the bugs that matter. **That was wrong.** Both defects found in the
pre-submission review (a forged `X-Forwarded-For` bypassing rate limits, and share views counted from
the web server's address) lived between the browser, the web server and the API — exactly where
`app.inject()` cannot see. The end-to-end suite in `e2e/` now pins both, along with the owner journey,
protected links, security headers and dialog focus handling. CI (`.github/workflows/ci.yml`) runs
every suite on each push.

**Real Postgres, real MinIO.** A mocked S3 will happily "delete" an object a real bucket keeps, and a
mocked database won't enforce the composite primary key that *is* the duplicate-membership guard —
which is test area 4. The bugs being graded live precisely in the gap between the fake and the real
thing. Cost: a slower suite, and Docker required. Worth it, and the trade-off is named in the README.

**Time is injected.** A `clock` dependency means expiry tests move the clock rather than sleeping. No
flaky `setTimeout` anywhere.

Each test file truncates its tables in `afterEach`. `vitest --pool=forks` with a single worker for the
integration project; the unit project runs in parallel with no containers, in about two seconds, for
the inner loop.

---

## The tests in detail

### 1. Authorization — `tests/security/cross-tenant.test.ts`
Table-driven. User B, with a valid session and their own workspace, attempts:

```
GET    /api/workspaces/:A/documents
POST   /api/workspaces/:A/documents
GET    /api/workspaces/:A/members
POST   /api/workspaces/:A/invitations
DELETE /api/documents/:Adoc            ← no workspace in the path
GET    /api/documents/:Adoc/download   ← no workspace in the path
POST   /api/shares   { documentId: Adoc }
DELETE /api/shares/:Ashare
```

All expect **404**. The last four matter most: they are addressed by object id without a workspace in
the URL, so the check uses the workspace on the document row. No route inherits a membership check
from its path — each calls it explicitly — so adding a route without wiring the check is exactly what
this suite exists to catch.

Also: a MEMBER calling `POST /api/workspaces/:id/invitations` expects **403**, not 404 — they are a
member, so the honest answer is "insufficient role".

### 2. Sharing — `tests/security/shares.test.ts`
- A valid link resolves and downloads.
- `revoked_at` set → **410** on the very next request.
- `expires_at` in the past (clock advanced, not slept) → **410**.
- Unknown token → 404.
- **Soft-deleting the document → 410 immediately**, with no other action taken.
- Tokens are ≥43 base64url characters and differ across 1,000 generations.
- A direct `SELECT token_hash FROM shares` never equals the plaintext — the token is genuinely
  hashed at rest.
- No share response body contains `storage_key`, `workspace_id`, or the uploader's email.

### 3. Uploads — `tests/integration/upload.test.ts`
- A 1 MB PDF succeeds; the row and the object both exist.
- A 30 MB file → **413**, and no row is created.
- A `.exe` (and a `.png` renamed to `.pdf`, caught by magic-byte sniffing) → **415**.
- An upload to a workspace the caller isn't in → 404.

### 4. Membership — `tests/integration/membership.test.ts`
- Accepting an invitation creates **exactly one** membership row.
- Accepting the same invitation twice → 409, still exactly one row.
- Inviting an existing member is a no-op, not a duplicate.
- Accepting with a mismatched email → 409, invite stays pending.
- Registering with an invite token joins the workspace **and** creates the user's own workspace, in
  one transaction.

### 5. Storage — `tests/integration/storage-failure.test.ts`
The blueprint's fifth area, and the one most people skip:

- **Object upload fails** (the storage double throws) → the request fails **and no `documents` row
  exists**.
- **Metadata insert fails** (a constraint violation is forced) → the request fails **and the object
  is gone from MinIO** — cleanup was attempted and succeeded.
- **Delete** soft-deletes the row, then removes the object; a subsequent download returns 404 and the
  object is absent from the bucket.
- A soft-deleted document disappears from listing **and** download **and** share resolution — one
  test covering all three, because with raw SQL the `deleted_at IS NULL` filter is a per-query
  responsibility and forgetting it in one place is the realistic bug.

### 6. Access visibility — `tests/integration/share-activity.test.ts`
Added with the product improvement:

- A new link reports zero opens, not `null` or a missing field.
- A resolve and a download count as two opens from one viewer.
- Four requests from three addresses count as four opens and three distinct viewers — the forwarding
  signal.
- An attempt on a **revoked** link records `revoked`; on a link whose document was deleted, records
  `document_deleted`.
- **The database never contains the raw address** — the test writes from a known IP and asserts the
  stored value is a 32-byte hash that contains it in neither encoding.
- The history endpoint returns an opaque viewer marker and the response body does not contain the
  address anywhere.
- Another workspace's member gets 404 on the history endpoint.

Because events are written fire-and-forget (telemetry must never block a download), these tests wait a
tick before asserting — deliberately, rather than making the write blocking just to make testing easier.

---

## Deliberately not tested

Getters, response mapping, React components, third-party libraries, and anything whose failure is
loud and immediate. "Some tests" means chosen tests, and the choosing is the signal.

`npm test` runs everything (Docker required: `docker compose up -d postgres minio` first).
`npm run test:unit` is container-free and finishes in about two seconds.

The rate limiter is not registered under `NODE_ENV=test`, because every request in the API suite
comes from the same address and the limiter would throttle the tests rather than the attack it exists
to stop. The per-address login limit is instead verified end-to-end (`e2e/tests/04-abuse-limits.spec.ts`),
through the web server, with a forged address on every request. Those tests use the limit up, so the
end-to-end suite expects a freshly started API.
