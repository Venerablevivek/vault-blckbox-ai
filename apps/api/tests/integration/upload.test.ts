import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, SAMPLE_PDF, type Harness } from '../helpers/harness';

/**
 * Blueprint test area 3: "Valid upload succeeds; oversize/unsupported files are rejected."
 */
describe('uploads', () => {
  let h: Harness;
  let alice: Awaited<ReturnType<typeof registerUser>>;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());

  beforeEach(async () => {
    await h.truncate();
    alice = await registerUser(h.app, 'alice@example.com');
  });

  it('stores the object and the metadata for a valid file', async () => {
    const response = await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'report.pdf');
    expect(response.statusCode).toBe(201);

    const doc = response.json().document;
    expect(doc.filename).toBe('report.pdf');
    expect(doc.mimeType).toBe('application/pdf');
    expect(doc.size).toBe(SAMPLE_PDF.length);

    const rows = await h.query<{ storage_key: string }>('SELECT storage_key FROM documents');
    expect(rows).toHaveLength(1);
    // The key is built from UUIDs only; no part of it comes from the filename.
    expect(rows[0]!.storage_key).toMatch(/^workspaces\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}$/);
    expect(await h.objectExists(rows[0]!.storage_key)).toBe(true);
  });

  it('rejects a file over the 25 MB limit and stores nothing', async () => {
    const tooBig = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(h.config.MAX_UPLOAD_BYTES + 1024, 0x41)]);

    const response = await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'huge.pdf', tooBig);
    expect(response.statusCode).toBe(413);
    expect(await h.query('SELECT 1 FROM documents')).toHaveLength(0);
  });

  it('rejects a disallowed type', async () => {
    const response = await uploadDocument(
      h.app,
      alice.cookie,
      alice.workspaceId,
      'malware.exe',
      Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
      'application/x-msdownload',
    );
    expect(response.statusCode).toBe(415);
    expect(await h.query('SELECT 1 FROM documents')).toHaveLength(0);
  });

  it('rejects an executable renamed and declared as a PDF', async () => {
    // The declared Content-Type is attacker-controlled, so it is checked against the bytes.
    const response = await uploadDocument(
      h.app,
      alice.cookie,
      alice.workspaceId,
      'invoice.pdf',
      Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
      'application/pdf',
    );
    expect(response.statusCode).toBe(415);
    expect(await h.query('SELECT 1 FROM documents')).toHaveLength(0);
  });

  it('rejects an empty file', async () => {
    const response = await uploadDocument(h.app, alice.cookie, alice.workspaceId, 'empty.pdf', Buffer.alloc(0));
    expect(response.statusCode).toBe(400);
  });

  it('issues a short-lived signed URL for download and never leaks the key', async () => {
    const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId);
    const documentId = upload.json().document.id;

    const response = await h.app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/download`,
      headers: { cookie: alice.cookie },
    });

    expect(response.statusCode).toBe(302);
    const location = response.headers.location as string;
    expect(location).toContain('X-Amz-Expires=60');
    expect(location).toContain('response-content-disposition');
    expect(upload.body).not.toContain('storage_key');
  });
});
