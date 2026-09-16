# 10 — Working With the Coding Agent

> *"Tell us in the README which agent(s) you used and how you worked with them… what you delegated,
> where it went wrong, how you caught it."*
> *"You steered the agent rather than accepting its first output, and you can explain every part of
> the codebase."*

This is a graded deliverable, so it gets a plan rather than a retrospective written from memory.

**Agent:** Claude Code (Opus). **Model of collaboration:** I own the decisions; the agent owns the
typing. The blueprint owns the scope — `AGENTS.md` carries its §10 exclusion list verbatim, so
"don't build that" is a rule the agent reads rather than something I have to catch in review.

---

## The split

| I decide (not delegated) | The agent writes (reviewed line by line) |
| --- | --- |
| Every gap the blueprint leaves open (`02-product-decisions.md` Part B) | The `.sql` migrations from the spec'd schema |
| The permission matrix | Route handlers, Zod schemas, service/repository plumbing |
| Share-link semantics: entropy, hashing, expiry, revocation, uniform failures | The `StorageProvider` adapters from the interface I define |
| Deletion & GC ordering (DB before bytes) | React components, forms, table states |
| Error-code semantics (404 vs 403 vs 410) | Docker/compose wiring, CI config |
| Layering rules and the lint that enforces them | Test scaffolding from the cases I enumerate |
| Which tests matter | Boilerplate, types, repetitive mapping, Tailwind markup |
| What stays out of scope | Everything inside the scope, written to spec |

The principle: **the agent is fast at what's already decided and confidently wrong at what isn't.**
Anything security- or product-shaped gets decided first, in writing (that's what these docs are), and
only then handed over.

---

## How I work with it

1. **Design docs first.** This whole `docs/` tree exists before any code. It's the specification the
   agent is held to, and it's why the agent can't invent a role model or a share-link policy — those
   are already written down, and traceable to the blueprint.
2. **One milestone per session** (`08-implementation-plan.md`), each ending in a runnable state.
3. **Tests for security-critical code are specified before implementation.** The agent writes the
   test from my enumerated cases, I check the cases are right, then it writes the code. Reversing this
   produces tests that assert whatever the code happens to do.
4. **Every diff is read.** Anything I can't explain gets rewritten or deleted before it's committed —
   the interview is a walkthrough, and "the agent wrote it" is not an answer.
5. **Small commits with real messages**, so the git history shows the direction, not one 4,000-line
   "initial commit".
6. **Rules the agent can't drift from** live in `CLAUDE.md` + ESLint (the layering `no-restricted-imports`
   rule), not in my memory of what I asked for.

---

## Where I expect it to go wrong (and the specific guard for each)

These are predictions, written in advance, to be replaced in the README with what actually happened.

| Predicted failure | Why agents do this | My guard |
| --- | --- | --- |
| Authorization checks inlined into handlers, subtly different each time | Each route is generated in isolation | One `can()` + a preHandler on the prefix; the table-driven cross-tenant test fails if a route skips it |
| Object key built from the user-supplied filename | It's the "natural" thing to write | `storage/keys.ts` is the only constructor; a lint rule bans `path.join` outside it; a test asserts keys are UUID-only |
| `crypto.randomUUID()` used as a share token | It's random-looking and convenient | Explicit spec: 32 bytes, base64url; a test asserts length and cross-generation uniqueness |
| Token stored in plaintext "for now" | Simpler to debug | Test asserts `token_hash != token` by querying the DB directly |
| Read-then-write on `view_count` | The obvious imperative shape | Spec'd as a single atomic `UPDATE … RETURNING`; a concurrency test proves it |
| Object deleted before the DB row commits | Reads top-to-bottom naturally | Spec'd ordering + the GC integration test |
| `SELECT * FROM documents WHERE id = $1` without the tenant filter | The id feels unique enough | Repository signatures take `workspaceId` first; the cross-tenant suite catches the rest |
| Presigned URL signed against the internal MinIO host | The internal client is already in scope | It fails immediately in the browser with `SignatureDoesNotMatch`; the dual-client split is spec'd in `technical.md` §6 |
| `deleted_at` filter forgotten in one query | Easy to miss on the tenth repository method | A base repository helper applies it; a test soft-deletes and asserts absence from every list endpoint |
| UI hides buttons instead of calling the API correctly | "Permissions handled" looks true visually | A test calls the forbidden endpoint directly and expects 403 — the button is never the boundary |
| Over-engineering: a generic RBAC engine, an event bus, a repository framework | Agents reach for extensible abstractions unprompted | Explicit scope in `CLAUDE.md`: "no abstraction without a second caller" |
| Tests written against the implementation (asserting current behaviour) | Written after the code, from the code | Security test cases enumerated by me before implementation |
| **`deleted_at IS NULL` forgotten in one query** | With raw SQL nothing adds it for you, and it's easy to miss on the tenth query | A test soft-deletes one document and asserts it vanishes from listing **and** download **and** share resolution |
| **`workspace_id` missing from a `WHERE` clause** | The document id feels unique enough on its own | Repository signatures take `workspaceId` first; the cross-tenant suite covers the two id-only routes explicitly |
| **String-interpolated SQL** | It reads more naturally than `$1, $2` | Lint rule bans template literals inside `db.query(...)`; review rejects any `${}` near SQL |
| **Row inserted before the object is uploaded** | Code reads top-to-bottom and the row feels like the "real" record | Spec'd order in `technical.md` §8, plus the blueprint's own storage-failure test |
| **No cleanup when the metadata insert fails** | The happy path works, so it looks done | It is literally test area 5; the test forces a constraint violation and asserts the object is gone |
| **Object key built from the user's filename** | It's the "natural" thing to write | `storage/keys.ts` is the only key constructor; a test asserts keys are UUID-only |
| **`randomUUID()` used as a share token** | Random-looking and convenient | Spec'd as 32 bytes base64url; a test asserts length and cross-generation uniqueness |
| **Token stored in plaintext "for now"** | Easier to debug | A test queries `token_hash` directly and asserts it differs from the plaintext |
| **Signed URL generated against the internal MinIO host** | The internal client is already in scope | Fails immediately in the browser with `SignatureDoesNotMatch`; the dual-client split is spec'd in `technical.md` §7 |
| **MIME type trusted from the client header** | It's right there in the multipart part | Allowlist checked against sniffed magic bytes; a `.png` renamed to `.pdf` is a test case |
| **Scope creep — a VIEWER role, folders, versioning, a component library** | Agents reach for completeness and for extensible abstractions unprompted | `AGENTS.md` carries the blueprint's §10 list verbatim: these are not to be built |
| **Tests written against the implementation** | Written after the code, from the code | The five blueprint test areas are enumerated before implementation |

---

## What goes in the README

The blueprint's §11 asks for: the agent(s) used, what was delegated, and what I personally reviewed,
changed or **rejected** — and to *"emphasize architecture decisions and trade-offs rather than
pretending the agent wrote everything without review."*

So the README section will contain **concrete incidents**, not this prediction table: what the agent
produced, what was wrong with it, how I noticed (test / review / running it), and what I changed.
Two or three real examples with the diff described beat a page of process description — and at least
one should be something I *rejected outright*, because that's the part that shows direction rather
than acceptance.
