# 06 — UI Specification

**Next.js (App Router) + TypeScript + Tailwind.**

The blueprint's constraint is explicit: *"Functional UI and correct authorization matter more than
polish"*, and *"do not build… a complex design system."*

What shipped honours the second clause and goes a little past the first: there is a site header, a
footer, a small colour palette and a set of local components — but **no component library, no design
system, no theming layer, and no dark mode**. Roughly a dozen `@layer components` classes in one CSS
file and a handful of `.tsx` components. Polish is not graded, so it was bought cheaply and late,
after the authorization work was finished and tested.

The UI calls the API through a **Next.js rewrite** (`/api/*` → `api:4000`), so everything is
same-origin: the session cookie just works and there is no CORS configuration to get wrong.

---

## Routes

| Route | Access | Purpose |
| --- | --- | --- |
| `/login` | public | Email + password. Demo credentials shown in development |
| `/register` | public | `?invite=<token>` pre-fills and locks the email |
| `/` | session | Redirects to the first workspace |
| `/workspaces/[id]` | member | **Document list** — the main screen. Upload, download, delete |
| `/workspaces/[id]/members` | member | Members list; invite form for OWNER |
| `/invite/[token]` | public | Invite landing → sign in or create account, then accept |
| `/s/[token]` | **public** | The recipient's page. No app chrome, no login prompt |

`/s/[token]` is a server component that fetches the share metadata and renders a 410 state directly —
the recipient never sees a loading spinner or a flash of the app shell.

---

## Screens

### Document list — `/workspaces/[id]`
A header with the workspace name, a workspace switcher, the caller's role, and an **Upload** button.
Below it, a plain table: filename, size, type, uploaded by, date, and per-row **Download** and
**Delete**.

Upload is a file input plus a drop zone over the table. Progress comes from
`XMLHttpRequest.upload.onprogress` — `fetch` has no upload progress, and a 25 MB file on a slow
connection needs a bar rather than a frozen button. A rejected file (too large, wrong type) shows the
server's message inline, next to the input, not as a toast that disappears.

### Members — `/workspaces/[id]/members`
Email, role and join date. For an OWNER, an invite form (email + role) below it.

After inviting, **the generated invite URL is displayed with a Copy button**, because the blueprint's
decision is to expose the link in development rather than integrate an email provider. The page says
so explicitly — *"In development, invitations are shown here instead of being emailed"* — so a
reviewer isn't left wondering where the email went.

### Public share page — `/s/[token]`
The only thing an outsider ever sees. A single centred card: filename, size, type, a Download button,
and when the link expires.

Dead link (revoked, expired, or the document was deleted): the same card, muted, reading *"This link
is no longer available — ask the sender for a new one."* Deliberately not a 404 page, because the
recipient should know the link was genuine.

---

## Permissions in the interface

`GET /api/auth/me` returns each workspace with the caller's role, and `GET /api/workspaces/:id/members`
confirms it. The UI uses that to render:

- The **Invite** form appears only for an OWNER.
- **Delete** is enabled only on documents the caller uploaded, unless they are the OWNER.
- The caller's role is visible next to the workspace name at all times.

The client mirrors the rules; it never owns them. Every guarded action is still checked server-side,
and a test calls a MEMBER-forbidden endpoint directly to prove the button is not the security
boundary.

---

## States

Every data view handles four: **loading** (a simple skeleton row, so layout doesn't jump), **empty**
(one sentence plus the primary action — *"No documents yet"* with the Upload button), **error**
(inline, with the server's message when it's actionable, and a retry), and **forbidden** (explains
the role requirement and offers a way back).

Delete asks for confirmation and names the file. Everything else is immediate.

---

## Styling

Tailwind utilities, system font stack, white background, neutral greys, one blue for primary actions,
red for destructive confirmation. Semantic HTML: real `<table>`, real `<button>`, real `<label for>`.
Visible focus rings everywhere. Layout stacks to one column on narrow screens.

That is the whole visual specification, and it's short on purpose — the blueprint says not to build a
design system, and time spent here is time not spent on authorization.
