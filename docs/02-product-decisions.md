# 02 — Product Decisions

The original brief says *"Where details are missing… **you decide**… and write it down."* The
blueprint decides most of them. This file records **the blueprint's decisions verbatim first**, then
the handful of gaps it leaves, each resolved in its spirit: *keep the weekend scope tight, keep
authorization easy to reason about.*

---

## Part A — Decisions taken from the blueprint (§3)

| Area | Decision |
| --- | --- |
| **Workspace roles** | **OWNER and MEMBER only.** Keep authorization easy to reason about |
| **Shared links** | Read-only public links; **optional expiration**; **creator can revoke**; **recipient does not need an account** |
| **Invitations** | Invite by email. An invited person can create an account or sign in before accepting |
| **Development email** | Expose the generated invitation link in development instead of integrating an email provider |
| **File limits** | **25 MB maximum**; allow common document/image types; document this in the README |
| **Deletion** | **Soft-delete document metadata, then remove the underlying object**; ensure deleted docs are not downloadable |

### The permission matrix (two roles, one screen)

| Action | OWNER | MEMBER |
| --- | :---: | :---: |
| List workspace documents | ✅ | ✅ |
| Upload a document | ✅ | ✅ |
| Download a document | ✅ | ✅ |
| Create a share link | ✅ | ✅ |
| Revoke a share link | ✅ any | ✅ own |
| Delete a document | ✅ any | ✅ own |
| List members | ✅ | ✅ |
| Invite a member | ✅ | ❌ |

"own" = `uploaded_by` / `created_by` equals the caller. That is the entire authorization model, and
being able to print it in eight rows is the point of the two-role decision.

---

## Part B — Gaps the blueprint leaves, and how they're filled

### G1 — Where does a document live if the user has no workspace?

**Decision.** `documents.workspace_id` is `NOT NULL` (the blueprint's schema says so), therefore
**every document belongs to a workspace**, and **registration auto-creates one** — `"My Workspace"`,
`created_by` = the new user, with an OWNER membership — inside the same transaction as the user row.

**Why.** The original brief asks for a solo "upload a document" flow *and* a team workspace flow. A
nullable owner column would create a second authorization path, and cross-tenant leaks live in the
branch you forgot. One model means one question for any document: *is the caller a member of
`document.workspace_id`?* One function, one test suite.

**Cost.** A brand-new user sees a workspace they didn't ask for. Naming it "My Workspace" and
defaulting into it makes that invisible.

### G2 — What does "authorization" mean for a document, precisely?

**Decision.** Membership in the document's workspace is necessary and sufficient for read and
download. Delete requires being the uploader or the workspace OWNER. There are no per-document
permissions.

### G3 — Do share links expire by default?

**Decision.** Default **7 days**, and the creator can choose 1 hour / 24 hours / 7 days / 30 days /
never. The blueprint says expiry is optional, so "never" is offered — but the default is bounded,
because the most common real incident with a share link is sending it to the wrong address.

### G4 — What exactly can a share link do, and what does it reveal?

**Decision.** Resolve one document's name, size and type, and download its bytes. Nothing else — not
the workspace, not the uploader, not the object key, not other documents. No upload, no delete, no
rename through a link, ever. Read-only, as specified.

**Token design.** `crypto.randomBytes(32)` → base64url (**256 bits**), prefixed `shr_` so it is
greppable in logs and redactable. The database stores **only `sha256(token)`**; the plaintext is
returned exactly once, at creation.

**Explicitly rejected:** using a long-lived signed S3 URL *as* the share link. It bypasses our
authorization, cannot be revoked, and leaks bucket topology — and the blueprint's own rule is *never
make the bucket public*.

### G5 — What happens when a share link is dead?

**Decision.** `410 Gone`, not `404`, for revoked / expired / document-deleted. The recipient should
know the link was genuine and can ask for a new one. An unknown token is `404`.

### G6 — Invitations: what if the person has no account?

**Decision.** Invite by email creates an `invitations` row with its own 256-bit hashed token, a role,
and a 7-day expiry. The invite link lands on a page that offers **sign in** or **create account** —
the blueprint's wording — and acceptance happens after authentication, in **one transaction** that
inserts the membership and stamps `accepted_at`.

- **The accepting account's email must match the invited email.** Otherwise a forwarded link is a
  privilege escalation.
- Inviting someone who is already a member is a no-op with a clear message.
- Single-use: `accepted_at` non-null means spent.
- In development the invite URL is **returned in the API response and logged**, per §3.

### G7 — Which MIME types are "common document/image types"?

**Decision.** An allowlist, checked against **sniffed magic bytes**, not the client's declared header:

`pdf` · `doc` `docx` · `xls` `xlsx` · `ppt` `pptx` · `txt` `csv` `md` · `png` `jpeg` `gif` `webp`

**SVG is excluded** — it is an executable document, and allowing it would mean relying entirely on
download headers to prevent stored XSS. Archives are excluded too: they hide their contents from any
future scanning.

### G8 — Deletion order, and what happens to links

**Decision.** In one request: soft-delete the row (`deleted_at = now()`), commit, **then** delete the
object. Share links pointing at the document stop resolving immediately (`410`) because every resolve
re-checks `deleted_at`; no cache, no cleanup pass needed.

**Order matters.** DB first, bytes second. A brief orphaned object is a cost problem; a row pointing
at a missing object is a 500 on every download. If the object delete fails, it is logged with the key
at `error` level for manual cleanup — a background reaper is out of scope for a weekend, and saying
so is better than pretending.

### G9 — Session lifetime

**Decision.** Opaque 256-bit token, `sha256` at rest, `HttpOnly` + `SameSite=Lax` + `Secure` in
production, 7-day expiry. Logout deletes the row. Server-side sessions, not JWTs, because removing a
member has to take effect on their next request — not when a token happens to expire.

### G10 — Error semantics for non-members

**Decision.** `404`, identical to a resource that never existed. `403` would confirm the workspace
exists — an enumeration oracle. Members lacking the OWNER role get `403`, because they already know
it exists and the honest answer is more useful.

---

## Part C — Deliberately not built

From the blueprint's §10, restated so each reads as a decision rather than an omission:

OAuth · SSO · MFA · billing · comments · document collaboration · **versioning** · notifications ·
search infrastructure · a complex design system. And, following its schema and API list: workspace
deletion, folders, quotas, and password-protected share links.

> **Later overrides, on explicit request:** in-app notifications, an audit trail, member removal and
> role changes (with a last-owner invariant), document and workspace rename, and inline preview were
> built after the first release. See README §9.

> *"Functional UI and correct authorization matter more than polish."*

---

## Summary: the four decisions I'd defend hardest

1. **Every document belongs to a workspace, and registration creates one.** One ownership model, so
   one authorization path.
2. **Two roles, eight permission rows.** Small enough to hold in your head, which is what makes it
   reviewable.
3. **Share links are database rows with hashed 256-bit tokens** — revocable and expiring — never
   long-lived signed URLs.
4. **Upload writes the object, then the row, and cleans up the object if the row fails.** Deletion
   goes the other way: row first, then bytes.
