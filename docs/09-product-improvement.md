# 09 — Open Space: Product Improvement

The original brief: *"pick **one** thing you believe a real user would want next and either build it
or write a one-page design note for it… Tell us why you chose it."*

**Chosen: share-link access visibility. Built.**

---

## Why this one

The blueprint's §10 is explicit about scope: do not build versioning, notifications, search
infrastructure, comments or collaboration. That rules out most of the original brief's own suggestion
list. Of what remains, folders and quotas are plumbing rather than insight, and virus scanning needs
an extra container and an async state machine.

Access visibility survived that filter for two reasons: it is the first question a real user asks
after sharing anything, and it is small enough to build *properly* rather than gesture at — one
table, one insert on a path that already existed, and one panel. It also closes a gap this design
already admitted to in [`05-security.md`](05-security.md).

---

## The problem

You send a contract to someone outside the company. Then: **did they open it?** When? Is that link
still live? Did they forward it to someone else?

Today the honest answer is *no idea*. The `shares` table records `created_at`, `expires_at` and
`revoked_at` — nothing about use. A link that's been open for six days and never clicked looks
exactly like one that's been downloaded forty times.

That uncertainty is why people retreat to email attachments, which is the exact behaviour this
product exists to replace. **Sharing without visibility is sharing with anxiety.**

## Why this one

1. **It's the first question every real user asks** after sending a link. Every product with share
   links — Dropbox, Drive, DocSend, Notion — has this, because every one of them learned it the same
   way.
2. **It fits the blueprint's scope.** It's one table and one screen. No new infrastructure, no queue,
   no external service, nothing on §10's forbidden list.
3. **It closes a gap this design already admits.** [`05-security.md`](05-security.md) lists "no audit
   log" under *knowingly left out*. This is that gap, framed as a product feature rather than a
   compliance checkbox — which is the more honest framing for a small team's document tool.

## What shipped

**One new table** (`apps/api/migrations/006_share_access_events.sql`):

```sql
CREATE TABLE share_access_events (
  id          uuid PRIMARY KEY,
  share_id    uuid NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  accessed_at timestamptz NOT NULL DEFAULT now(),
  ip_hash     bytea NOT NULL,        -- HMAC-SHA256(ip, server pepper). Never the raw address
  user_agent  text,
  outcome     text NOT NULL          -- 'ok' | 'expired' | 'revoked' | 'not_found'
);
CREATE INDEX share_access_events_share_id_idx ON share_access_events (share_id, accessed_at DESC);
```

One insert on the existing public resolve and download paths — written **fire-and-forget**, because
a failure to record telemetry must never stop someone downloading a document they are entitled to.
Two read paths: a rollup joined into the document list, and `GET /api/shares/:id/events` for detail.

**Three things in the UI:**

1. **In the document list.** `2 links · 6 opens · last 3 minutes ago`, or `2 links · unopened`. A
   lateral join keeps this one query, so the question is answerable without opening anything.
2. **In the share dialog.** Per-link opens, estimated distinct viewers, first and last access, and an
   expandable history where each event shows its outcome and an opaque viewer marker. An unopened
   link says so plainly — *"Not opened yet · nobody has used this link"* — because *did it arrive?*
   is usually the real question, not *who exactly opened it?*
3. **A forwarding signal.** Three or more distinct networks on a link sent to one person raises a
   warning with the useful action right beside it: revoke and issue a new one. Attempts on an
   already-dead link are counted separately and surfaced too.

## The privacy stance — the part that needed deciding, not defaulting

The person opening the link **is not our user**. They never agreed to be tracked. So:

- Store `sha256(pepper ‖ ip)`, **never the raw IP**, and never derive a location from it. A test
  asserts the address never reaches the database in any encoding.
- Show the creator counts and coarse signals only — never an address, never a city. The history shows
  an 8-character hash prefix as a stable "same viewer" marker and nothing more.
- **Say so on the public share page**: *"The sender can see when this link is opened, and can revoke
  it at any time."* It is there in the shipped page, not just in this document.
- Delete access events with the link (`ON DELETE CASCADE`), and with the document.

The feature is about link hygiene, not surveillance, and the data model should make the surveillance
version *harder* to build, not easier. That constraint is the interesting part of the design, and
it's the reason to write it down before writing any code.

## Cost, risks, and what was left

- IP-hash distinctness is defeated by CGNAT (false merge) and mobile network hopping (false split).
  Hence **"~3 viewers"** and an explicit line in the dialog saying the count is approximate — stated
  in the interface rather than buried here.
- An access log on a hot public path is a write on every request. Fine at this scale; the first thing
  to batch if a link ever gets genuinely hot.
- **Not built:** notify-on-first-open and a weekly digest. Both need real mail infrastructure, and
  notifications are explicitly out of scope. The forwarding heuristic shipped last on purpose — it is
  the one with false positives, so it is phrased as a suggestion rather than an accusation.
- Aggregation is computed per request rather than materialised. Correct at this size; a counter column
  on `shares` would be the optimisation, at the cost of a second source of truth.

---

## What I'd build next after that

In order, and with reasons rather than as a wish list: **an audit trail for workspace actions**
(who invited whom, who deleted what — the same substrate, extended); **virus scanning** on upload,
because a shared link is a malware distribution channel; **folders**, once a workspace passes a few
dozen documents; and **password-protected links**, which turns a leaked URL into a non-event.
