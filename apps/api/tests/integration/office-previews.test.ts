import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';
import { textPdf } from '../helpers/files';

type User = Awaited<ReturnType<typeof registerUser>>;

/** A legacy .doc as far as the type check goes: the OLE compound-file signature, then filler. */
const LEGACY_DOC = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(512, 0)]);

describe('office previews through Gotenberg', () => {
  let h: Harness;
  let owner: User;
  let gotenberg: Server;
  const received: Array<{ path: string; filename: string | null }> = [];
  let failNext = false;

  beforeAll(async () => {
    // A stand-in for Gotenberg: answers the LibreOffice route with a real PDF.
    const pdf = await textPdf('Converted from Word: quarterly forecast');
    gotenberg = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (c: Buffer) => chunks.push(c));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1');
        received.push({ path: request.url ?? '', filename: /filename="([^"]+)"/.exec(body)?.[1] ?? null });
        if (failNext) {
          failNext = false;
          response.writeHead(500).end('conversion failed');
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/pdf' }).end(pdf);
      });
    });
    await new Promise<void>((resolve) => gotenberg.listen(0, '127.0.0.1', resolve));
    const { port } = gotenberg.address() as AddressInfo;
    h = await createHarness({ env: { OFFICE_PREVIEWS: 'gotenberg', GOTENBERG_URL: `http://127.0.0.1:${port}` } });
  });
  afterAll(async () => {
    await h.close();
    await new Promise((resolve) => gotenberg.close(resolve));
  });
  beforeEach(async () => {
    await h.truncate();
    received.length = 0;
    owner = await registerUser(h.app, 'owner@example.com');
  });

  const call = (method: string, url: string) =>
    h.app.inject({ method: method as 'GET', url, headers: { cookie: owner.cookie } });

  it('previews, draws and indexes an Office file from the PDF Gotenberg makes of it', async () => {
    const upload = await uploadDocument(
      h.app,
      owner.cookie,
      owner.workspaceId,
      'forecast.doc',
      LEGACY_DOC,
      'application/msword',
    );
    expect(upload.statusCode, upload.body).toBe(201);
    const id = upload.json().document.id;
    expect(upload.json().document.previewable).toBe(false);
    await h.drainJobs();

    expect(received).toEqual([{ path: '/forms/libreoffice/convert', filename: 'document.doc' }]);
    const listed = (await call('GET', `/api/workspaces/${owner.workspaceId}/documents`)).json().documents[0];
    expect(listed).toMatchObject({ previewable: true, thumbnail: true });

    const preview = await call('GET', `/api/documents/${id}/preview`);
    expect(preview.statusCode).toBe(302);
    const location = String(preview.headers.location);
    expect(decodeURIComponent(location)).toContain('response-content-type=application/pdf');
    expect(decodeURIComponent(location)).toContain('forecast.pdf');
    expect((await (await fetch(location)).arrayBuffer()).byteLength).toBeGreaterThan(100);

    // The download is still the original file.
    const download = await call('GET', `/api/documents/${id}/download`);
    expect(Buffer.from(await (await fetch(String(download.headers.location))).arrayBuffer()).equals(LEGACY_DOC)).toBe(
      true,
    );

    const found = (await call('GET', `/api/workspaces/${owner.workspaceId}/documents?q=forecast`)).json().documents;
    expect(found[0].matchSnippet).toContain('⟦forecast⟧');
  });

  it('carries on without a preview when conversion fails', async () => {
    failNext = true;
    const upload = await uploadDocument(
      h.app,
      owner.cookie,
      owner.workspaceId,
      'broken.doc',
      LEGACY_DOC,
      'application/msword',
    );
    const id = upload.json().document.id;
    await h.drainJobs();
    const [row] = await h.query<{ processing_status: string; preview_key: string | null }>(
      'SELECT processing_status, preview_key FROM documents WHERE id = $1',
      [id],
    );
    expect(row).toEqual({ processing_status: 'failed', preview_key: null });
    expect((await call('GET', `/api/documents/${id}/preview`)).statusCode).toBe(415);
  });
});
