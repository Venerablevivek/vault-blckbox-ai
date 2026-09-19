# Design Documentation — File Storage & Sharing

Design documentation for the take-home in [`../file-sharing-assignment.pdf`](../file-sharing-assignment.pdf),
built to the **recommended architecture blueprint**
([`../file_storage_sharing_takehome_blueprint.pdf`](../file_storage_sharing_takehome_blueprint.pdf)).

**Status: implemented.** Start with [`../README.md`](../README.md) — it is the graded deliverable.
These documents hold the reasoning behind it, including the alternatives considered and rejected.

> The blueprint is the authority for stack, roles, schema, API shape and scope. Where it is silent,
> the choice is recorded — and labelled as ours — in [`02-product-decisions.md`](02-product-decisions.md) Part B.

| Doc | What it answers |
| --- | --- |
| [`01-brief-analysis.md`](01-brief-analysis.md) | What the original brief requires, how it's graded, and how the blueprint resolves it |
| [`02-product-decisions.md`](02-product-decisions.md) | **Part A:** the blueprint's decisions. **Part B:** the gaps it leaves, resolved. Feeds the README's most-weighted section |
| [`../technical.md`](../technical.md) | Stack, architecture, layering, flows, config, compose topology |
| [`03-data-model.md`](03-data-model.md) | The specified tables as DDL, plus every later migration (001–036) |
| [`04-api-spec.md`](04-api-spec.md) | Conventions, plus the generated reference of every route |
| [`05-security.md`](05-security.md) | The blueprint's nine controls; the rubric's three questions; **what's knowingly left out** |
| [`06-ui-spec.md`](06-ui-spec.md) | Next.js routes, screens, dialogs, permission rendering |
| [`07-testing-strategy.md`](07-testing-strategy.md) | The five test areas the blueprint names, the later suites, and the end-to-end tests |
| [`08-implementation-plan.md`](08-implementation-plan.md) | Milestones, ordering rationale, cut list, definition of done |
| [`09-product-improvement.md`](09-product-improvement.md) | Open Space: share-link access visibility — **built** |
| [`10-agent-workflow.md`](10-agent-workflow.md) | How the coding agent is directed, and where it's expected to go wrong |
| [`11-performance.md`](11-performance.md) | The k6 load test and its results |
| [`adr/README.md`](adr/README.md) | Seventeen decision records, walkthrough-ready |

## The design in ten lines

- **Next.js + Tailwind** UI → **Fastify** API → **PostgreSQL (`pg`, raw SQL)** for metadata +
  **MinIO** for bytes. Modular monolith. `docker compose up --build` brings up all four services.
- **Migrations** are ordered `.sql` files run by a small runner at API startup. No ORM.
- **Every document belongs to a workspace**, and registration auto-creates one — so there is exactly
  one authorization path.
- **Two roles, OWNER and MEMBER**, and a permission matrix that fits in eight rows. (A read-only
  VIEWER was added later on request.)
- **Share links are database rows** holding `sha256` of a 256-bit token — read-only, optionally
  expiring, revocable, no account needed. Never a long-lived signed URL.
- **Bytes stream through the API**: object written first, row second, object deleted if the row fails.
  Deletion goes the other way — row first, then bytes (now after a 30-day trash window).
- **The bucket is never public** — no read policy is ever applied, so it stays at MinIO's private default
  (not actively re-verified at boot). Downloads are 60-second signed URLs.
- **25 MB cap** and a MIME allowlist checked against sniffed magic bytes, not the client's header.
- **Tests aim at the five areas the blueprint names**, against a real Postgres and a real MinIO.
- **Share links report their own use** — opens, estimated viewers, and a forwarding signal, with the
  visitor's address hashed and never stored.
- **An owner-only audit trail and in-app notifications** ("your link was opened"), the latter added on
  request as a recorded override of the blueprint.
- **What's knowingly missing is written down** — no tamper-evident audit, no virus scanning, no email
  verification, no RLS, no CSRF token.

## Out of scope, by instruction

OAuth · SSO · MFA · billing · comments · document collaboration · versioning · notifications ·
search infrastructure · a complex design system. And no microservices, Redis, Kafka, Elasticsearch,
Kubernetes, or ORM.

## Added after the first build

On explicit request, and recorded as overrides of the blueprint rather than drift: member management,
rename, preview, notifications, the audit trail, the dashboard, **trash and restore (30 days)**,
**folders**, **server-side search and keyset pagination**, **password-protected and download-limited
links with editable expiry**, the **VIEWER role**, per-account **login lockout**, upload concurrency
limits, a **maintenance job**, web **security headers**, in-app **dialogs** replacing browser
`prompt`/`confirm`, **Playwright end-to-end tests** and **CI**. Where a document below describes the
original design, the README describes what the code does now.
