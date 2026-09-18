import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { textPdf } from '../helpers/files';
import { createHarness, registerUser, SAMPLE_PDF, uploadDocument, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

/** A minimal .docx: enough for the type check (a zip) and for text extraction. */
function docx(text: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from('<?xml version="1.0"?><Types/>'), '[Content_Types].xml');
    zip.addBuffer(
      Buffer.from(`<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`),
      'word/document.xml',
    );
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('thumbnails and content search', () => {
  let h: Harness;
  let owner: User;

  beforeAll(async () => {
    h = await createHarness({ env: { PROCESSING_MAX_BYTES: '20000' } });
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.truncate();
    owner = await registerUser(h.app, 'owner@example.com');
  });

  const call = (method: string, url: string, user: User = owner) =>
    h.app.inject({ method: method as 'GET', url, headers: { cookie: user.cookie } });

  async function upload(name: string, body: Buffer, type: string): Promise<string> {
    const res = await uploadDocument(h.app, owner.cookie, owner.workspaceId, name, body, type);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().document.id;
  }

  async function search(q: string) {
    const res = await call('GET', `/api/workspaces/${owner.workspaceId}/documents?q=${encodeURIComponent(q)}`);
    return res.json().documents as Array<{ filename: string; matchSnippet: string | null; thumbnail: boolean }>;
  }

  const status = async (id: string) =>
    (await h.query<{ processing_status: string }>('SELECT processing_status FROM documents WHERE id = $1', [id]))[0]!
      .processing_status;

  it('finds documents by the words inside them, with the match highlighted', async () => {
    await upload(
      'q3.pdf',
      await textPdf('Revenue grew in the third quarter', 'Outstanding invoice from Acme'),
      'application/pdf',
    );
    await upload('minutes.docx', await docx('The board approved the marketing budget'), DOCX);
    await upload('notes.txt', Buffer.from('Remember to renew the lease.'), 'text/plain');
    await upload('budget-2027.txt', Buffer.from('nothing relevant inside'), 'text/plain');
    await h.drainJobs();

    // Stemming: "invoices" finds "invoice".
    const invoices = await search('invoices');
    expect(invoices.map((d) => d.filename)).toEqual(['q3.pdf']);
    expect(invoices[0]!.matchSnippet).toContain('⟦invoice⟧');

    // A name match and a text match together; the name match has no snippet.
    const budget = await search('budget');
    expect(budget.map((d) => d.filename).sort()).toEqual(['budget-2027.txt', 'minutes.docx']);
    expect(budget.find((d) => d.filename === 'budget-2027.txt')!.matchSnippet).toBeNull();
    expect(budget.find((d) => d.filename === 'minutes.docx')!.matchSnippet).toContain('⟦budget⟧');

    expect((await search('lease')).map((d) => d.filename)).toEqual(['notes.txt']);
    expect(await search('photosynthesis')).toEqual([]);
    // Words that are all stop-words match nothing by text, and don't break the name search.
    expect(await search('the')).toEqual([]);
  });

  it('draws thumbnails of PDFs and pictures, served to members only', async () => {
    const pdf = await upload('report.pdf', await textPdf('Cover page'), 'application/pdf');
    const image = await upload('pixel.png', PNG, 'image/png');
    const text = await upload('plain.txt', Buffer.from('no picture for text'), 'text/plain');
    await h.drainJobs();

    for (const id of [pdf, image]) {
      const res = await call('GET', `/api/documents/${id}/thumbnail`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toBe('private, max-age=86400');
      expect(res.rawPayload.subarray(8, 12).toString('latin1')).toBe('WEBP');
    }
    expect((await call('GET', `/api/documents/${text}/thumbnail`)).statusCode).toBe(404);
    const listed = (await call('GET', `/api/workspaces/${owner.workspaceId}/documents`)).json().documents;
    expect(
      Object.fromEntries(listed.map((d: { filename: string; thumbnail: boolean }) => [d.filename, d.thumbnail])),
    ).toEqual({
      'report.pdf': true,
      'pixel.png': true,
      'plain.txt': false,
    });

    const outsider = await registerUser(h.app, 'outsider@example.com');
    expect((await call('GET', `/api/documents/${pdf}/thumbnail`, outsider)).statusCode).toBe(404);
  });

  it('starts over for a new version, and removes what it derived from the old one', async () => {
    const id = await upload('plan.txt', Buffer.from('original plan mentions giraffes'), 'text/plain');
    await h.drainJobs();
    expect((await search('giraffes')).length).toBe(1);

    const boundary = '----processing';
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/documents/${id}/versions`,
      headers: { cookie: owner.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="plan.txt"\r\nContent-Type: text/plain\r\n\r\n`,
        ),
        Buffer.from('revised plan mentions elephants'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(res.statusCode, res.body).toBe(201);
    // The old text stops matching at once, before the worker has read the new one.
    expect(await search('giraffes')).toEqual([]);
    await h.drainJobs();
    expect((await search('elephants')).length).toBe(1);

    const picture = await upload('photo.png', PNG, 'image/png');
    await h.drainJobs();
    const [before] = await h.query<{ thumbnail_key: string }>('SELECT thumbnail_key FROM documents WHERE id = $1', [
      picture,
    ]);
    expect(await h.objectExists(before!.thumbnail_key)).toBe(true);
    await call('DELETE', `/api/documents/${picture}`);
    await h.app.inject({
      method: 'DELETE',
      url: `/api/documents/${picture}/permanent`,
      headers: { cookie: owner.cookie },
    });
    expect(await h.objectExists(before!.thumbnail_key)).toBe(false);
  });

  it('marks files it cannot read or that are too large, without retrying them', async () => {
    const broken = await upload('broken.pdf', SAMPLE_PDF, 'application/pdf');
    const big = await upload('big.txt', Buffer.from('x'.repeat(25_000)), 'text/plain');
    await h.drainJobs();
    expect(await status(broken)).toBe('failed');
    expect(await status(big)).toBe('skipped');
    const failedJobs = await h.query(`SELECT 1 FROM jobs WHERE queue = 'document.process' AND status <> 'done'`);
    expect(failedJobs).toHaveLength(0);
  });

  it('waits for the malware scan, and the maintenance pass picks up anything never processed', async () => {
    const id = await upload('later.txt', Buffer.from('processed later: zebras'), 'text/plain');
    await h.drainJobs();
    await h.query(
      `UPDATE documents SET scan_status = 'pending', processing_status = 'pending', processed_key = NULL WHERE id = $1`,
      [id],
    );
    await h.query('DELETE FROM document_contents');
    await h.app.services.documents.processDocument(id);
    expect(await status(id)).toBe('pending');

    await h.query(`UPDATE documents SET scan_status = 'clean' WHERE id = $1`, [id]);
    const result = await h.app.maintenance.runOnce();
    expect(result!.queuedProcessing).toBe(1);
    await h.drainJobs();
    expect(await status(id)).toBe('done');
    expect((await search('zebras')).length).toBe(1);
  });
});
