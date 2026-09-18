import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function realPdf(pages = 2, padding = 0): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) pdf.addPage([595, 842]).drawText(`Page ${i + 1}`, { x: 50, y: 780 });
  if (padding) pdf.setSubject('x'.repeat(padding));
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

/** Every content stream in a PDF, inflated where compressed, as one string to search. */
function pdfContent(pdf: Buffer): string {
  const text = pdf.toString('latin1');
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) break;
    const raw = pdf.subarray(start, end);
    try {
      out.push(inflateSync(raw).toString('latin1'));
    } catch {
      out.push(raw.toString('latin1'));
    }
    re.lastIndex = end + 'endstream'.length;
  }
  return out.join('\n');
}

/** pdf-lib writes standard-font text as a hex string of its Latin-1 codes. */
const hexOf = (text: string) => Buffer.from(text, 'latin1').toString('hex').toUpperCase();

describe('view-only and restricted share links', () => {
  let h: Harness;
  let owner: User;

  beforeAll(async () => {
    h = await createHarness({ env: { SHARE_WATERMARK_MAX_BYTES: '40000' } });
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.truncate();
    owner = await registerUser(h.app, 'owner@example.com');
  });

  async function upload(name: string, body: Buffer, type: string): Promise<string> {
    const res = await uploadDocument(h.app, owner.cookie, owner.workspaceId, name, body, type);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().document.id;
  }

  async function share(documentId: string, settings: Record<string, unknown>) {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/shares',
      headers: { cookie: owner.cookie },
      payload: { documentId, ...settings },
    });
    return res;
  }

  const tokenOf = (res: { json(): { share: { url: string } } }) => res.json().share.url.split('/s/')[1]!;

  /** A public request, with an optional grant cookie; returns the response and any new grant. */
  async function pub(method: 'GET' | 'POST', url: string, cookie?: string, payload?: object) {
    const res = await h.app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });
    const set = res.headers['set-cookie'];
    const raw = Array.isArray(set) ? set[0] : set;
    return { res, cookie: raw ? String(raw).split(';')[0]! : cookie };
  }

  describe('view-only links', () => {
    it('show a PDF with the viewer watermarked into every page, and never download it', async () => {
      const original = await realPdf(3);
      const id = await upload('terms.pdf', original, 'application/pdf');
      const created = await share(id, { allowDownload: false, maxDownloads: 2 });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json().share).toMatchObject({ allowDownload: false, allowedEmails: [] });
      const token = tokenOf(created);

      const meta = (await pub('GET', `/api/shares/${token}`)).res.json();
      expect(meta).toMatchObject({ locked: false, allowDownload: false, previewable: true, restricted: false });
      expect(meta.watermark).toMatch(/^viewer [0-9a-f]{8} - \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC - shared via Vault$/);

      const download = (await pub('GET', `/api/shares/${token}/download`)).res;
      expect(download.statusCode).toBe(403);
      expect(download.json().error.code).toBe('DOWNLOAD_DISABLED');
      const [row] = await h.query<{ download_count: number }>('SELECT download_count FROM shares');
      expect(row!.download_count).toBe(0);

      const content = (await pub('GET', `/api/shares/${token}/content`)).res;
      expect(content.statusCode).toBe(200);
      expect(content.headers['content-type']).toBe('application/pdf');
      expect(content.headers['content-disposition']).toMatch(/^inline; filename="terms.pdf"/);
      expect(content.headers['cache-control']).toBe('private, no-store');
      expect(content.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(Number(content.headers['content-length'])).toBe(content.rawPayload.length);
      expect(content.rawPayload.equals(original)).toBe(false);

      const marked = await PDFDocument.load(content.rawPayload);
      expect(marked.getPageCount()).toBe(3);
      const streams = pdfContent(content.rawPayload);
      // Three diagonal marks and a footer on each of the three pages.
      expect(streams.split(hexOf(meta.watermark)).length - 1).toBe(12);
    });

    it('serve images as they are: the page overlays the watermark', async () => {
      const id = await upload('photo.png', PNG, 'image/png');
      const token = tokenOf(await share(id, { allowDownload: false }));
      const content = (await pub('GET', `/api/shares/${token}/content`)).res;
      expect(content.headers['content-type']).toBe('image/png');
      expect(content.rawPayload.equals(PNG)).toBe(true);
      expect((await pub('GET', `/api/shares/${token}`)).res.json().watermark).toMatch(/^viewer /);
    });

    it('are refused for files a browser cannot show, when created or edited', async () => {
      const id = await upload('notes.txt', Buffer.from('plain text'), 'text/plain');
      const res = await share(id, { allowDownload: false });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('VIEW_ONLY_UNSUPPORTED');

      const open = await share(id, {});
      const edit = await h.app.inject({
        method: 'PATCH',
        url: `/api/shares/${open.json().share.id}`,
        headers: { cookie: owner.cookie },
        payload: { allowDownload: false },
      });
      expect(edit.statusCode).toBe(422);
      const text = (await pub('GET', `/api/shares/${tokenOf(open)}/content`)).res;
      expect(text.statusCode).toBe(415);
    });

    it('refuse to show a PDF they cannot stamp, or one too large to stamp, rather than show it unmarked', async () => {
      const broken = await upload('broken.pdf', Buffer.from('%PDF-1.4\nnot really a pdf\n%%EOF\n'), 'application/pdf');
      const res = (await pub('GET', `/api/shares/${tokenOf(await share(broken, { allowDownload: false }))}/content`))
        .res;
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('PREVIEW_UNAVAILABLE');

      const big = await upload('big.pdf', await realPdf(1, 50_000), 'application/pdf');
      const tooBig = (await pub('GET', `/api/shares/${tokenOf(await share(big, { allowDownload: false }))}/content`))
        .res;
      expect(tooBig.statusCode).toBe(413);
      expect(tooBig.json().error.code).toBe('TOO_LARGE_TO_VIEW');
    });

    it('can be turned back into a normal link, which then shows and downloads the original', async () => {
      const original = await realPdf(1);
      const id = await upload('a.pdf', original, 'application/pdf');
      const created = await share(id, { allowDownload: false });
      const token = tokenOf(created);
      const edit = await h.app.inject({
        method: 'PATCH',
        url: `/api/shares/${created.json().share.id}`,
        headers: { cookie: owner.cookie },
        payload: { allowDownload: true },
      });
      expect(edit.json().share.allowDownload).toBe(true);
      expect((await pub('GET', `/api/shares/${token}/content`)).res.rawPayload.equals(original)).toBe(true);
      expect((await pub('GET', `/api/shares/${token}/download`)).res.statusCode).toBe(302);
      expect((await pub('GET', `/api/shares/${token}`)).res.json().watermark).toBeNull();
    });

    it('never show a file in the page when its link has a download limit', async () => {
      const id = await upload('limited.pdf', await realPdf(1), 'application/pdf');
      const token = tokenOf(await share(id, { maxDownloads: 1 }));
      expect((await pub('GET', `/api/shares/${token}`)).res.json().previewable).toBe(false);
      const res = (await pub('GET', `/api/shares/${token}/content`)).res;
      expect(res.statusCode).toBe(403);
      // Viewing is unaffected, and the one download is still there.
      expect((await pub('GET', `/api/shares/${token}/download`)).res.statusCode).toBe(302);
    });
  });

  describe('links restricted to named people', () => {
    let docId: string;
    beforeEach(async () => {
      docId = await upload('plan.pdf', await realPdf(1), 'application/pdf');
    });

    async function codeFor(email: string): Promise<string> {
      const mail = await h.mailer.waitFor((m) => m.to === email && /\d{6}/.test(m.subject));
      h.mailer.sent.splice(h.mailer.sent.indexOf(mail), 1);
      return /(\d{6})/.exec(mail.subject)![1]!;
    }

    it('stay locked until an address on the link proves itself with an emailed code', async () => {
      const created = await share(docId, {
        allowedEmails: ['Alice@Example.com ', 'bob@example.com', 'alice@example.com'],
      });
      expect(created.json().share.allowedEmails).toEqual(['alice@example.com', 'bob@example.com']);
      const token = tokenOf(created);

      expect((await pub('GET', `/api/shares/${token}`)).res.json()).toEqual({
        locked: true,
        requiresEmail: true,
        requiresPassword: false,
        expiresAt: expect.any(String),
      });
      for (const [method, path] of [
        ['POST', 'view'],
        ['GET', 'download'],
        ['GET', 'content'],
      ] as const) {
        const res = (await pub(method, `/api/shares/${token}/${path}`)).res;
        expect(res.statusCode, path).toBe(401);
        expect(res.json().error.code).toBe('EMAIL_REQUIRED');
      }

      // A stranger gets exactly the same answer, and no email.
      const stranger = (await pub('POST', `/api/shares/${token}/code`, undefined, { email: 'eve@example.com' })).res;
      const alice = (await pub('POST', `/api/shares/${token}/code`, undefined, { email: 'ALICE@example.com' })).res;
      expect(stranger.statusCode).toBe(202);
      expect(stranger.body).toBe(alice.body);
      const code = await codeFor('alice@example.com');
      await h.drainJobs();
      expect(h.mailer.sent.filter((m) => m.to === 'eve@example.com')).toHaveLength(0);

      const wrong = (
        await pub('POST', `/api/shares/${token}/verify`, undefined, {
          email: 'alice@example.com',
          code: code === '000000' ? '111111' : '000000',
        })
      ).res;
      expect(wrong.json().error.code).toBe('WRONG_CODE');

      const right = await pub('POST', `/api/shares/${token}/verify`, undefined, { email: 'alice@example.com', code });
      expect(right.res.statusCode).toBe(204);
      expect(right.res.headers['set-cookie']).toMatch(/HttpOnly/);
      const meta = (await pub('GET', `/api/shares/${token}`, right.cookie)).res.json();
      expect(meta).toMatchObject({ locked: false, restricted: true, viewerEmail: 'alice@example.com' });
      expect((await pub('GET', `/api/shares/${token}/download`, right.cookie)).res.statusCode).toBe(302);

      // The code worked once.
      const again = (await pub('POST', `/api/shares/${token}/verify`, undefined, { email: 'alice@example.com', code }))
        .res;
      expect(again.json().error.code).toBe('CODE_INVALID');

      // The sender sees who opened it, and the wrong code.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const events = await h.app.inject({
        method: 'GET',
        url: `/api/shares/${created.json().share.id}/events`,
        headers: { cookie: owner.cookie },
      });
      const seen = events.json().events.map((e: { outcome: string; email: string | null }) => [e.outcome, e.email]);
      expect(seen).toContainEqual(['downloaded', 'alice@example.com']);
      expect(seen).toContainEqual(['bad_code', 'alice@example.com']);
    });

    it('accept only the newest code, for ten minutes and five tries', async () => {
      const token = tokenOf(await share(docId, { allowedEmails: ['alice@example.com'] }));
      const verify = (code: string) =>
        pub('POST', `/api/shares/${token}/verify`, undefined, { email: 'alice@example.com', code }).then((r) => r.res);

      await pub('POST', `/api/shares/${token}/code`, undefined, { email: 'alice@example.com' });
      const first = await codeFor('alice@example.com');
      await pub('POST', `/api/shares/${token}/code`, undefined, { email: 'alice@example.com' });
      const second = await codeFor('alice@example.com');
      // With the clock frozen both codes carry the same send time: the older one must still be dead.
      if (first !== second) expect((await verify(first)).json().error.code).toBe('WRONG_CODE');

      h.clock.advanceHours(11 / 60);
      expect((await verify(second)).json().error.code).toBe('CODE_INVALID');

      await pub('POST', `/api/shares/${token}/code`, undefined, { email: 'alice@example.com' });
      const third = await codeFor('alice@example.com');
      const bad = third === '999999' ? '888888' : '999999';
      for (let i = 0; i < 4; i += 1) expect((await verify(bad)).json().error.code).toBe('WRONG_CODE');
      expect((await verify(bad)).json().error.code).toBe('CODE_INVALID');
      expect((await verify(third)).json().error.code).toBe('CODE_INVALID');
    });

    it('leave exactly one live code when several are requested at once', async () => {
      const created = await share(docId, { allowedEmails: ['alice@example.com'] });
      const token = tokenOf(created);
      await Promise.all(
        [1, 2, 3].map(() => pub('POST', `/api/shares/${token}/code`, undefined, { email: 'alice@example.com' })),
      );
      const live = await h.query('SELECT 1 FROM share_email_codes WHERE consumed_at IS NULL');
      expect(live).toHaveLength(1);
    });

    it('send at most three codes to an address in fifteen minutes', async () => {
      const token = tokenOf(await share(docId, { allowedEmails: ['alice@example.com'] }));
      for (let i = 0; i < 5; i += 1) {
        expect(
          (await pub('POST', `/api/shares/${token}/code`, undefined, { email: 'alice@example.com' })).res.statusCode,
        ).toBe(202);
      }
      await h.drainJobs();
      expect(h.mailer.sent.filter((m) => m.to === 'alice@example.com')).toHaveLength(3);
    });

    it('shut a person out as soon as they are removed from the link, and never unlock another link', async () => {
      const created = await share(docId, { allowedEmails: ['alice@example.com'] });
      const token = tokenOf(created);
      await pub('POST', `/api/shares/${token}/code`, undefined, { email: 'alice@example.com' });
      const { cookie } = await pub('POST', `/api/shares/${token}/verify`, undefined, {
        email: 'alice@example.com',
        code: await codeFor('alice@example.com'),
      });
      expect((await pub('GET', `/api/shares/${token}`, cookie)).res.json().locked).toBe(false);

      // The same grant presented to a different link, under that link's cookie name.
      const other = tokenOf(await share(docId, { allowedEmails: ['alice@example.com'] }));
      const otherName = (await import('../../src/modules/shares/shares.service')).grantCookieName(other);
      const moved = `${otherName}=${cookie!.split('=').slice(1).join('=')}`;
      expect((await pub('GET', `/api/shares/${other}`, moved)).res.json().locked).toBe(true);

      await h.app.inject({
        method: 'PATCH',
        url: `/api/shares/${created.json().share.id}`,
        headers: { cookie: owner.cookie },
        payload: { allowedEmails: ['bob@example.com'] },
      });
      expect((await pub('GET', `/api/shares/${token}`, cookie)).res.json()).toMatchObject({
        locked: true,
        requiresEmail: true,
      });
    });

    it('combine with a password, in either order, and watermark with the verified address', async () => {
      const token = tokenOf(
        await share(docId, { allowedEmails: ['alice@example.com'], password: 'open-sesame', allowDownload: false }),
      );
      expect((await pub('GET', `/api/shares/${token}`)).res.json()).toMatchObject({
        locked: true,
        requiresEmail: true,
        requiresPassword: true,
      });

      // Password first, then the code: the password is kept.
      let { cookie } = await pub('POST', `/api/shares/${token}/unlock`, undefined, { password: 'open-sesame' });
      expect((await pub('GET', `/api/shares/${token}`, cookie)).res.json()).toMatchObject({
        requiresEmail: true,
        requiresPassword: false,
      });
      await pub('POST', `/api/shares/${token}/code`, undefined, { email: 'alice@example.com' });
      ({ cookie } = await pub('POST', `/api/shares/${token}/verify`, cookie, {
        email: 'alice@example.com',
        code: await codeFor('alice@example.com'),
      }));
      const meta = (await pub('GET', `/api/shares/${token}`, cookie)).res.json();
      expect(meta).toMatchObject({ locked: false, viewerEmail: 'alice@example.com' });
      expect(meta.watermark).toMatch(/^alice@example\.com - /);

      const content = (await pub('GET', `/api/shares/${token}/content`, cookie)).res;
      expect(pdfContent(content.rawPayload)).toContain(hexOf(meta.watermark));

      // Code first, then the password: the address is kept.
      await pub('POST', `/api/shares/${token}/code`, undefined, { email: 'alice@example.com' });
      let fresh = (
        await pub('POST', `/api/shares/${token}/verify`, undefined, {
          email: 'alice@example.com',
          code: await codeFor('alice@example.com'),
        })
      ).cookie;
      fresh = (await pub('POST', `/api/shares/${token}/unlock`, fresh, { password: 'open-sesame' })).cookie;
      expect((await pub('GET', `/api/shares/${token}`, fresh)).res.json()).toMatchObject({ locked: false });
    });

    it('rejects malformed address lists and codes', async () => {
      expect((await share(docId, { allowedEmails: ['not-an-email'] })).statusCode).toBe(400);
      const tooMany = Array.from({ length: 51 }, (_, i) => `p${i}@example.com`);
      expect((await share(docId, { allowedEmails: tooMany })).statusCode).toBe(400);
      const token = tokenOf(await share(docId, { allowedEmails: ['alice@example.com'] }));
      const res = (
        await pub('POST', `/api/shares/${token}/verify`, undefined, { email: 'alice@example.com', code: '12ab' })
      ).res;
      expect(res.statusCode).toBe(400);
    });
  });
});
