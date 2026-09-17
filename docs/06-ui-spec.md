# 06 — UI Specification

**Next.js (App Router) + TypeScript + Tailwind.**

The blueprint's constraint is explicit: *"Functional UI and correct authorization matter more than
polish"*, and *"do not build… a complex design system."*

The first version was a plain table and a members list. The interface was later redesigned on
request (sidebar, dashboard, icons, colour), but it still has **no component library, no design
system and no theming layer**: a small Tailwind palette, a set of `@layer components` classes in one
CSS file, local `.tsx` components and `lucide-react` icons.

The UI calls the API through a **Next.js rewrite** (`/api/*` → `api:4000`), so everything is
same-origin: the session cookie just works and there is no CORS configuration to get wrong. In the
container the app runs through `server.mjs`, which adds the security headers and sets the real
status code on the public share page.

---

## Routes

| Route | Access | Purpose |
| --- | --- | --- |
| `/login` | public | Email + password. Demo credentials shown in development |
| `/register` | public | `?invite=<token>` pre-fills and locks the email |
| `/` | session | Redirects to the first workspace |
| `/workspaces/[id]` | member | **Overview** — totals, 14-day charts (in the browser's time zone), storage by type, most-viewed links, recent activity (owners) |
| `/workspaces/[id]/documents` | member | **Documents** — the main screen. `?folder=<id>` opens a folder |
| `/workspaces/[id]/members` | member | Members and roles; invitations and role changes for owners |
| `/workspaces/[id]/activity` | owner | The audit trail, grouped by day |
| `/workspaces/[id]/settings` | member | Rename the workspace (owner); leave it |
| `/invite/[token]` | public | Invite landing → sign in or create account, then accept |
| `/s/[token]` | **public** | The recipient's page. No app chrome, no login prompt |

---

## Screens

### Documents — `/workspaces/[id]/documents`
Tabs **All · Shared · Mine · Trash**, each with a count. A search box (press `/`) searches file names
across the whole workspace, a sort menu (newest, oldest, name, size) and a list/grid toggle. Folders
appear above the files, with a breadcrumb path. The list loads 50 at a time and fetches more as you
scroll; all filtering, sorting and paging happen on the server.

Per document: preview (PDFs and images), **Share**, and a menu with download, rename, move to folder
and move to trash. Upload is a button, a drop zone over the list, or several files at once, with
progress from `XMLHttpRequest.upload.onprogress` — `fetch` has no upload progress. A rejected file
shows the server's message.

**Trash** shows who deleted each file, when, and the date it will be removed for good, with
**Restore** and (owners only) **Delete forever**. Switching tabs clears the old rows immediately, and a
response that arrives after a newer request is ignored, so rows from one view are never drawn in
another.

### Share panel
Lists live links with their expiry, a **Password** badge and `n of m downloads`, plus opens, downloads,
estimated viewers, blocked attempts and a forwarding warning. **Edit** changes expiry, password and
download limit on a live link. **New link** offers expiry, a download limit (including one-time) and
an optional password. The full URL is shown once, at creation, with a Copy button.

### Members — `/workspaces/[id]/members`
Email, role and join date. Owners can invite (Owner, Member or Viewer), change roles, remove people
and cancel invitations; a short legend explains the three roles. After inviting, the invitation URL
is shown with a Copy button, because no email provider is integrated.

### Public share page — `/s/[token]`
A single centred card: file name, size, type, a Download button, expiry and downloads left, and the
notice that the sender can see when the link is opened.

- **Password-protected:** a password form, and nothing about the file — not even its name — until it
  is unlocked. Wrong passwords show an inline error; too many lock the link.
- **Dead link** (revoked, expired, document trashed, downloads used up): the same card, muted, saying
  which. The page is served with **410** (or **404** for an unknown token), so crawlers and link
  checkers see the truth, while the recipient still learns the link was genuine.

---

## Dialogs

Every confirmation and text entry — rename, new folder, move to trash, delete forever, revoke link,
new workspace, leave, remove member — uses one in-app dialog system (`components/dialog.tsx`), never
the browser's `prompt()` or `confirm()`, which can't be styled, can't explain consequences and are
blocked in some embedded browsers. Each dialog:

- renders in a portal with `role="dialog"`, `aria-modal`, and a labelled title and description;
- moves focus inside on open, **traps Tab and Shift+Tab**, and closes on Escape or the backdrop;
- makes the rest of the page `inert`, and supports stacking (a confirm on top of the share panel);
- returns focus to the control that opened it.

Destructive confirmations name the file and use a red button. The end-to-end suite fails if any native
dialog opens, and checks the focus trap and focus return.

---

## Permissions in the interface

The list response includes the caller's role, and the UI renders from it:

- **Viewer:** no Upload, New folder, Share, rename, move or trash controls, and an empty folder
  doesn't invite them to upload.
- **Member:** rename, move and trash only on their own documents and folders; others' show the action
  disabled with a reason.
- **Owner:** everything, plus Delete forever, member management and the Activity page.

The client mirrors the rules; it never owns them. Every guarded action is checked on the server, and
tests call the forbidden endpoints directly to prove the button is not the security boundary.

---

## States

Every data view handles **loading** (skeleton rows, so layout doesn't jump), **empty** (one sentence
plus the primary action), **error** (inline, with the server's message and a retry) and **forbidden**.
Notifications poll every 20 seconds while the tab is visible, stop while it is hidden, and refresh as
soon as it becomes visible again.

---

## Styling

Tailwind utilities, the system font stack, a light theme with an indigo brand colour and red
for destructive actions. Semantic HTML: real `<button>`, real `<label for>`, landmarks and tab roles.
Visible focus rings everywhere. A sidebar that becomes a drawer on narrow screens.
