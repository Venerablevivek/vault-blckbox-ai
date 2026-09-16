# 01 — Brief Analysis

Sources: `file-sharing-assignment.pdf` (the assignment, 2 pages) and
`file_storage_sharing_takehome_blueprint.pdf` (the recommended architecture blueprint, 3 pages).

This document is my structured read of the **assignment**: what is explicitly required, what is
deliberately left open, and how the work will be graded. The **blueprint** then resolves most of what
the assignment leaves open — stack, roles, schema, API shape, file limits, deletion semantics and
scope — and is treated as authoritative throughout the rest of `docs/`.

---

## 1. What the exercise actually is

> "We don't expect a production system — we care about your judgement, code quality, and how you communicate trade-offs."

Three signals worth internalising before writing a line of code:

| Signal in the brief | What it means for how we build |
| --- | --- |
| "Don't spend more than a weekend" | Scope is a **hard constraint**. A narrow, complete, well-argued system beats a broad half-finished one. |
| "This brief is intentionally incomplete… you decide" | The **gaps are the exam.** Filling them well and writing them down is worth more than extra features. |
| "Use a coding agent… what we're evaluating is how well you direct the agent" | The process is graded. We need an **agent log** — what was delegated, what the agent got wrong, how it was caught. |
| "Expect the follow-up interview to include a code walkthrough" | No magic. Every file must be explainable. Rules out heavy scaffolding/black-box frameworks we can't defend line by line. |
| "We do **not** grade on visual design, cloud deployment, or test coverage %" | Don't gold-plate CSS. Don't deploy. Don't chase 90% coverage — chase the *right* tests. |

---

## 2. Explicit functional requirements

The three user stories, verbatim intent:

1. **Upload a document and keep it somewhere safe.**
2. **Share a document with someone outside the team by sending them a link.**
3. **Create a workspace, invite colleagues into it, and organize documents there** so the team isn't passing files around one at a time.

Plus: *"Build a small full-stack application (API + web UI) that does this."*

→ Three bounded contexts fall straight out: **Documents/Storage**, **Public Sharing**, **Workspaces/Membership**. Auth is the implicit fourth.

---

## 3. Hard constraints (non-negotiable)

| # | Constraint | Exact wording | Our reading (per the blueprint) |
| --- | --- | --- | --- |
| C1 | Language | Python **or** Node.js (**TypeScript preferred**) | **Node.js + TypeScript + Fastify** |
| C2 | Database | **PostgreSQL, with migrations** | **PostgreSQL + `pg` raw SQL**; ordered `.sql` migrations run automatically at API startup. No ORM |
| C3 | File storage | **Not in Postgres.** S3-compatible (MinIO locally) **or local disk behind an abstraction you could swap** | **MinIO via the S3 API**, behind the blueprint's four-method `FileStorage` interface |
| C4 | UI | **In scope.** Any framework. **Functional over pretty.** | **Next.js + TypeScript + Tailwind.** No component library, no design system — the blueprint forbids one |
| C5 | Run | **`docker compose up` brings up everything** | `docker compose up --build` is the primary path: `postgres`, `minio`, `api`, `web`. No manual `psql`, no manual bucket creation |
| C6 | Tests | "Some. Aim them at the parts that would **embarrass you if they broke**." | **Vitest**, aimed at the blueprint's five areas: authorization, sharing, uploads, membership, storage failure |

Everything else — *"auth approach, frameworks, file size limits, role model, API shape"* — is
explicitly ours to choose, **and the blueprint chooses it**: session cookies, Fastify/Next.js, 25 MB,
OWNER + MEMBER, and a fixed route table. See [`02-product-decisions.md`](02-product-decisions.md).

---

## 4. Open Space requirement

> "Once the core works, pick **one** thing you believe a real user would want next and either **build it** or write a **one-page design note**… Tell us why you chose it."

Examples they list: versioning, password-protected links, quotas, folders, audit trail, virus scanning, search, notifications.

→ See [`09-product-improvement.md`](09-product-improvement.md). The blueprint's §10 excludes
versioning, notifications, search and collaboration, which removes most of that list — so the choice
is **share-link access visibility, delivered as a design note**, which the assignment explicitly
permits. Choosing not to build is itself the decision, and it's made deliberately.

---

## 5. Deliverables checklist

- [ ] Git repository with source, **migrations**, **tests**, **`docker-compose.yml`**, **`.env.example`**
- [ ] **README** covering:
  - [ ] How to run it (<5 min from clone)
  - [ ] Short architecture overview
  - [ ] **Assumptions and decisions — every gap filled, what and why** ← *"This is the most important section."*
  - [ ] Security considerations addressed **and ones knowingly left**
  - [ ] Product improvement (built or designed)
  - [ ] **How you worked with your coding agent** — delegated / went wrong / how caught
  - [ ] What you'd do next with more time

Note the asymmetry: the README carries as much weight as the code. It is a first-class deliverable, not documentation debt.

---

## 6. Grading rubric → engineering obligations

| Rubric item | Their question (paraphrased) | What we must be able to show |
| --- | --- | --- |
| **Problem framing** | Did you notice what was missing, or build only what was literally written? | A written gap register with resolutions → [`02-product-decisions.md`](02-product-decisions.md) |
| **Security & authorization** | Can one user reach another user's files? Are share links guessable? Is the storage backend exposed? | Single authorization choke point; 256-bit link tokens stored hashed; private bucket, no public policy, short-lived presigned URLs only |
| **Data modelling** | Does the schema reflect the domain? Does it handle **deletion and membership** cleanly? | Explicit lifecycle: soft delete → retention → blob GC. Membership as a first-class table with role, not a boolean. |
| **Code quality** | Readable, organized, idiomatic. **Storage and auth aren't tangled into request handlers.** | Layered: `routes → services → repositories`, `storage/` and `auth/` as injected ports. Handlers do validation + delegation only. |
| **UI** | Core flows work end-to-end; **the interface reflects permissions correctly** | A viewer must not see an enabled Delete button. Server enforces, client mirrors. |
| **Communication** | Does the README explain **why**? Are trade-offs named honestly? | Decision tables with *rejected alternatives*, plus an explicit "knowingly left" security list. |
| **Agent direction** | Did you steer, or accept first output? Can you explain every part? | An agent log with concrete caught-mistakes → [`10-agent-workflow.md`](10-agent-workflow.md) |

**Explicit non-goals (stated by them):** visual polish, cloud deployment, coverage percentage.

---

## 7. The gap register (what the brief leaves undefined)

These are the questions the brief poses and refuses to answer. Each one is resolved in
[`02-product-decisions.md`](02-product-decisions.md) — this table is the index.

| ID | Open question (their words / implied) | Resolved by |
| --- | --- | --- |
| G1 | What can a "link" do? View? Download? Edit? Forever? | Blueprint §3 — read-only, optional expiry, revocable, no account |
| G2 | Who is allowed to do what inside a workspace? | Blueprint §3 — OWNER and MEMBER only |
| G3 | What happens when things **expire**? | Ours — 7-day defaults, `410 Gone` for dead links |
| G4 | What happens when things **get deleted**? | Blueprint §3 — soft-delete metadata, then remove the object |
| G5 | How do invitations behave **for people who don't have an account yet**? | Blueprint §3 — sign in or create an account before accepting |
| G6 | Auth approach | Blueprint §1 — email/password + server-side session cookie |
| G7 | Where do files live if a user has no workspace? | Ours — registration auto-creates one; `workspace_id` is never null |
| G8 | File size limits, allowed types | Blueprint §3 — 25 MB, common document/image types |
| G9 | API shape | Blueprint §6 — a fixed 14-route table |
| G10 | Does an external link recipient need an account? | Blueprint §3 — no |
| G11 | Can a share link be revoked? Audited? | Blueprint §3 — revocable. Audited: no, and that's the improvement design note |
| G12 | What happens to a workspace when its owner leaves? | Out of scope — the blueprint's API has no member-removal route |
| G13 | Organisation within a workspace (folders?) | Out of scope — a flat list per workspace |
| G14 | Email delivery for invites | Blueprint §3 — expose the invite link in development, no provider |

---

## 8. Reading between the lines — what they are really testing

1. **Do you build one ownership model or two?** The naive build has "my files" *and* "workspace files" with duplicated permission checks. That's where cross-tenant bugs live. (Resolved: G7 — everything is a workspace, and registration creates one.)
2. **Is the storage backend reachable without going through your authorization?** If the bucket is public or the presigned URL is long-lived and shareable, the authorization model is decorative.
3. **Is your share token guessable, and what does it leak?** A sequential ID or a UUIDv4 in a URL is a finding. So is storing the token in plaintext in the DB.
4. **Does deleting something actually delete it?** Row gone, object still in the bucket = a data-retention bug they will ask about in the walkthrough. The mirror of it is a failed upload that leaves metadata behind — which is why the blueprint makes it test area 5.
5. **Can you explain your own code?** Which quietly constrains stack choice more than any benchmark does.
