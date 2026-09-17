import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MIN_PART_SIZE, planParts } from '../../src/modules/uploads/uploads.service';
import { createHarness, registerUser, type Harness } from '../helpers/harness';

type User = Awaited<ReturnType<typeof registerUser>>;

/**
 * Direct uploads against real MinIO: parts are PUT to signed URLs exactly as a browser would, and
 * completion is verified against storage's own record.
 */
describe('direct uploads', () => {
  let h: Harness;
  let alice: User;

  beforeAll(async () => {
    h = await createHarness({ worker: false, env: { MAX_DIRECT_UPLOAD_BYTES: String(64 * 1024 * 1024) } });
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.truncate();
    alice = await registerUser(h.app, 'alice@example.com');
  });

  const call = (method: string, url: string, cookie?: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: cookie ? { cookie } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  /** A PDF of exactly `size` bytes. */
  const pdfOfSize = (size: number) => {
    const body = Buffer.alloc(size, 0x20);
    Buffer.from('%PDF-1.4\n').copy(body, 0);
    return body;
  };
  const usage = async (workspaceId = alice.workspaceId) =>
    Number(
      (
        await h.query<{ used: string }>('SELECT storage_used_bytes AS used FROM workspaces WHERE id = $1', [
          workspaceId,
        ])
      )[0]!.used,
    );

  async function start(
    body: Buffer,
    overrides: Record<string, unknown> = {},
    user = alice,
    workspaceId = alice.workspaceId,
  ) {
    const response = await call('POST', `/api/workspaces/${workspaceId}/uploads`, user.cookie, {
      filename: 'report.pdf',
      size: body.length,
      mimeType: 'application/pdf',
      ...overrides,
    });
    return response;
  }

  /** Uploads the given parts of `body` the way a browser does: PUT to the signed URL, keep the ETag. */
  async function putParts(uploadId: string, body: Buffer, partSize: number, partNumbers: number[]) {
    const signed = await call('POST', `/api/uploads/${uploadId}/parts`, alice.cookie, { partNumbers });
    expect(signed.statusCode, signed.body).toBe(200);
    for (const { partNumber, url } of signed.json().parts as Array<{ partNumber: number; url: string }>) {
      const chunk = body.subarray((partNumber - 1) * partSize, partNumber * partSize);
      const response = await fetch(url, { method: 'PUT', body: chunk });
      expect(response.status).toBe(200);
      expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]+"$/);
    }
  }

  it('plans 8 MiB parts, growing only past 10,000 parts', () => {
    expect(planParts(1)).toEqual({ partSize: MIN_PART_SIZE, partCount: 1 });
    expect(planParts(MIN_PART_SIZE + 1)).toEqual({ partSize: MIN_PART_SIZE, partCount: 2 });
    const huge = planParts(200 * 1024 ** 3);
    expect(huge.partCount).toBeLessThanOrEqual(10_000);
    expect(huge.partSize * huge.partCount).toBeGreaterThanOrEqual(200 * 1024 ** 3);
  });

  it('uploads a two-part file straight to storage and creates the document', async () => {
    const body = pdfOfSize(MIN_PART_SIZE + 1234);
    const created = await start(body);
    expect(created.statusCode, created.body).toBe(201);
    const upload = created.json().upload;
    expect(upload).toMatchObject({ partSize: MIN_PART_SIZE, partCount: 2, status: 'pending' });
    // Quota is reserved for the whole file as soon as the upload starts.
    expect(await usage()).toBe(body.length);

    await putParts(upload.id, body, upload.partSize, [1, 2]);
    const completed = await call('POST', `/api/uploads/${upload.id}/complete`, alice.cookie);
    expect(completed.statusCode, completed.body).toBe(201);
    const document = completed.json().document;
    expect(document).toMatchObject({
      filename: 'report.pdf',
      size: body.length,
      mimeType: 'application/pdf',
      sha256: null,
    });
    expect(await usage()).toBe(body.length);

    // The checksum is computed by a job, streaming the object back from storage.
    await h.runJobs();
    const listed = await call('GET', `/api/workspaces/${alice.workspaceId}/documents`, alice.cookie);
    expect(listed.json().documents[0].sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect((await call('GET', `/api/documents/${document.id}/download`, alice.cookie)).statusCode).toBe(302);
  });

  it('can be resumed: reports received parts, and refuses to complete until all are there', async () => {
    const body = pdfOfSize(MIN_PART_SIZE + 10);
    const upload = (await start(body)).json().upload;
    await putParts(upload.id, body, upload.partSize, [1]);

    const status = await call('GET', `/api/uploads/${upload.id}`, alice.cookie);
    expect(status.json().uploadedParts).toEqual([{ partNumber: 1, size: MIN_PART_SIZE }]);

    const early = await call('POST', `/api/uploads/${upload.id}/complete`, alice.cookie);
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toMatchObject({ code: 'UPLOAD_INCOMPLETE', message: 'Parts still missing: 2.' });
    expect((await call('GET', `/api/uploads/${upload.id}`, alice.cookie)).json().upload.status).toBe('pending');

    await putParts(upload.id, body, upload.partSize, [2]);
    expect((await call('POST', `/api/uploads/${upload.id}/complete`, alice.cookie)).statusCode).toBe(201);
  });

  it('rejects a file whose content is not the declared type, deleting it and releasing quota', async () => {
    const body = Buffer.concat([Buffer.from('MZ\x90\x00'), Buffer.alloc(200, 1)]);
    const upload = (await start(body)).json().upload;
    await putParts(upload.id, body, upload.partSize, [1]);

    const completed = await call('POST', `/api/uploads/${upload.id}/complete`, alice.cookie);
    expect(completed.statusCode).toBe(415);
    const [row] = await h.query<{ status: string; storage_key: string }>('SELECT status, storage_key FROM uploads');
    expect(row!.status).toBe('rejected');
    expect(await h.objectExists(row!.storage_key)).toBe(false);
    expect(await usage()).toBe(0);
    expect(await h.query('SELECT 1 FROM documents')).toHaveLength(0);
  });

  it('rejects parts that do not add up to the declared size', async () => {
    const declared = pdfOfSize(500);
    const upload = (await start(declared)).json().upload;
    await putParts(upload.id, pdfOfSize(200), upload.partSize, [1]);

    const completed = await call('POST', `/api/uploads/${upload.id}/complete`, alice.cookie);
    expect(completed.statusCode).toBe(400);
    expect(completed.json().error.code).toBe('UPLOAD_SIZE_MISMATCH');
    expect(await usage()).toBe(0);
  });

  it('refuses disallowed types, oversize files and uploads that would exceed the quota', async () => {
    expect((await start(pdfOfSize(10), { mimeType: 'application/x-msdownload' })).statusCode).toBe(415);
    expect((await start(pdfOfSize(10), { size: 65 * 1024 * 1024 })).statusCode).toBe(413);

    await h.query('UPDATE workspaces SET storage_quota_bytes = 1000 WHERE id = $1', [alice.workspaceId]);
    expect((await start(pdfOfSize(600))).statusCode).toBe(201);
    const second = await start(pdfOfSize(600));
    expect(second.statusCode).toBe(413);
    expect(second.json().error.code).toBe('QUOTA_EXCEEDED');
  });

  it('releases reserved quota when an upload is cancelled', async () => {
    const upload = (await start(pdfOfSize(700))).json().upload;
    expect(await usage()).toBe(700);
    expect((await call('DELETE', `/api/uploads/${upload.id}`, alice.cookie)).statusCode).toBe(204);
    expect(await usage()).toBe(0);
    expect((await call('POST', `/api/uploads/${upload.id}/parts`, alice.cookie, { partNumbers: [1] })).statusCode).toBe(
      409,
    );
  });

  it('keeps an upload private to the person who started it, and closes viewers out', async () => {
    const upload = (await start(pdfOfSize(100))).json().upload;
    const bob = await registerUser(h.app, 'bob@example.com');
    for (const [method, path, payload] of [
      ['GET', `/api/uploads/${upload.id}`, undefined],
      ['POST', `/api/uploads/${upload.id}/parts`, { partNumbers: [1] }],
      ['POST', `/api/uploads/${upload.id}/complete`, undefined],
      ['DELETE', `/api/uploads/${upload.id}`, undefined],
    ] as const) {
      expect((await call(method, path, bob.cookie, payload)).statusCode, `${method} ${path}`).toBe(404);
    }
    expect((await start(pdfOfSize(100), {}, bob, alice.workspaceId)).statusCode).toBe(404);

    const invite = await call('POST', `/api/workspaces/${alice.workspaceId}/invitations`, alice.cookie, {
      email: 'bob@example.com',
      role: 'VIEWER',
    });
    await call('POST', `/api/invitations/${invite.json().inviteUrl.split('/invite/')[1]}/accept`, bob.cookie);
    expect((await start(pdfOfSize(100), {}, bob, alice.workspaceId)).statusCode).toBe(403);
  });

  it('expires abandoned uploads, aborting them in storage and returning their quota', async () => {
    const body = pdfOfSize(300);
    const upload = (await start(body)).json().upload;
    await putParts(upload.id, body, upload.partSize, [1]);

    h.clock.advanceHours(25);
    const result = await h.app.maintenance.runOnce();
    expect(result!.expiredUploads).toBe(1);
    expect(await usage()).toBe(0);
    expect((await h.query<{ status: string }>('SELECT status FROM uploads'))[0]!.status).toBe('expired');
  });

  it('creates exactly one document when completion is requested twice at once', async () => {
    const body = pdfOfSize(400);
    const upload = (await start(body)).json().upload;
    await putParts(upload.id, body, upload.partSize, [1]);

    const results = await Promise.all([
      call('POST', `/api/uploads/${upload.id}/complete`, alice.cookie),
      call('POST', `/api/uploads/${upload.id}/complete`, alice.cookie),
    ]);
    expect(results.some((r) => r.statusCode === 201)).toBe(true);
    expect(results.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);
    expect(await h.query('SELECT 1 FROM documents')).toHaveLength(1);
    // A retry after success returns the same document.
    const again = await call('POST', `/api/uploads/${upload.id}/complete`, alice.cookie);
    expect(again.statusCode).toBe(201);
    expect(again.json().document.id).toBe(results.find((r) => r.statusCode === 201)!.json().document.id);
  });

  it('puts the document at the root if its folder was deleted during the upload', async () => {
    const folder = (
      await call('POST', `/api/workspaces/${alice.workspaceId}/folders`, alice.cookie, { name: 'Temp' })
    ).json().folder;
    const body = pdfOfSize(100);
    const upload = (await start(body, { folderId: folder.id })).json().upload;
    await putParts(upload.id, body, upload.partSize, [1]);
    expect(
      (await call('DELETE', `/api/workspaces/${alice.workspaceId}/folders/${folder.id}`, alice.cookie)).statusCode,
    ).toBe(204);

    const completed = await call('POST', `/api/uploads/${upload.id}/complete`, alice.cookie);
    expect(completed.json().document.folderId).toBeNull();
  });
});
