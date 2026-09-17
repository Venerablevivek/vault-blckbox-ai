import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, registerUser, uploadDocument, type Harness } from '../helpers/harness';
import type { FileStorage } from '../../src/storage/file-storage';

/**
 * Blueprint test area 5: "Metadata is not persisted when an object upload fails (and
 * cleanup is attempted on partial failure)."
 *
 * This is the area most implementations skip, so each half of it is asserted explicitly.
 */
class FailingUploadStorage implements FileStorage {
  async upload(): Promise<void> {
    throw new Error('simulated object store outage');
  }
  async download(): Promise<Readable> {
    return Readable.from(Buffer.alloc(0));
  }
  async delete(): Promise<void> {}
  async getSignedUrl(): Promise<string> {
    return 'http://example.invalid/signed';
  }
}

/** Uploads succeed, but we record whether the cleanup delete was called. */
class RecordingStorage implements FileStorage {
  readonly uploaded: string[] = [];
  readonly deleted: string[] = [];
  async upload(key: string): Promise<void> {
    this.uploaded.push(key);
  }
  async download(): Promise<Readable> {
    return Readable.from(Buffer.alloc(0));
  }
  async delete(key: string): Promise<void> {
    this.deleted.push(key);
  }
  async getSignedUrl(): Promise<string> {
    return 'http://example.invalid/signed';
  }
}

describe('storage failure handling', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('persists no metadata when the object upload fails', async () => {
    h = await createHarness({ storage: new FailingUploadStorage() });
    await h.truncate();
    const alice = await registerUser(h.app, 'alice@example.com');

    const response = await uploadDocument(h.app, alice.cookie, alice.workspaceId);

    expect(response.statusCode).toBe(500);
    // The row is written only after the object exists, so there is nothing to clean up.
    expect(await h.query('SELECT 1 FROM documents')).toHaveLength(0);
  });

  it('deletes the object when the metadata insert fails', async () => {
    const recording = new RecordingStorage();
    h = await createHarness({ storage: recording });
    await h.truncate();
    const alice = await registerUser(h.app, 'alice@example.com');

    // Force the insert to fail by removing the column the row depends on being valid:
    // dropping the workspace makes the foreign key violate, mid-request.
    await h.query('ALTER TABLE documents ADD CONSTRAINT never_insert CHECK (false) NOT VALID');
    await h.query('ALTER TABLE documents VALIDATE CONSTRAINT never_insert').catch(() => undefined);

    const response = await uploadDocument(h.app, alice.cookie, alice.workspaceId);

    expect(response.statusCode).toBe(500);
    expect(await h.query('SELECT 1 FROM documents')).toHaveLength(0);
    // The partial write was cleaned up: the object we just wrote was deleted again.
    expect(recording.uploaded).toHaveLength(1);
    expect(recording.deleted).toEqual(recording.uploaded);

    await h.query('ALTER TABLE documents DROP CONSTRAINT never_insert');
  });

  it('keeps the object while a document is in the trash, and removes it on permanent delete', async () => {
    h = await createHarness();
    await h.truncate();
    const alice = await registerUser(h.app, 'alice@example.com');

    const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId);
    const documentId = upload.json().document.id;
    const [row] = await h.query<{ storage_key: string }>('SELECT storage_key FROM documents');
    expect(await h.objectExists(row!.storage_key)).toBe(true);

    const remove = await h.app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
      headers: { cookie: alice.cookie },
    });
    expect(remove.statusCode).toBe(200);

    // In the trash: the row is soft-deleted but the bytes stay, so the delete can be undone.
    const [deleted] = await h.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM documents WHERE id = $1', [
      documentId,
    ]);
    expect(deleted!.deleted_at).not.toBeNull();
    expect(await h.objectExists(row!.storage_key)).toBe(true);

    // Permanent delete removes the object, then the row.
    const purge = await h.app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}/permanent`,
      headers: { cookie: alice.cookie },
    });
    expect(purge.statusCode).toBe(204);
    expect(await h.objectExists(row!.storage_key)).toBe(false);
    expect(await h.query('SELECT 1 FROM documents WHERE id = $1', [documentId])).toHaveLength(0);
  });

  it('makes a soft-deleted document vanish from listing, download AND share resolution', async () => {
    h = await createHarness();
    await h.truncate();
    const alice = await registerUser(h.app, 'alice@example.com');

    const upload = await uploadDocument(h.app, alice.cookie, alice.workspaceId);
    const documentId = upload.json().document.id;

    const share = await h.app.inject({
      method: 'POST',
      url: '/api/shares',
      headers: { cookie: alice.cookie },
      payload: { documentId },
    });
    const token = share.json().share.url.split('/s/')[1];

    await h.app.inject({
      method: 'DELETE',
      url: `/api/documents/${documentId}`,
      headers: { cookie: alice.cookie },
    });

    // With raw SQL the `deleted_at IS NULL` filter is a per-query responsibility, so all
    // three read paths are checked — forgetting it in exactly one place is the real bug.
    const list = await h.app.inject({
      method: 'GET',
      url: `/api/workspaces/${alice.workspaceId}/documents`,
      headers: { cookie: alice.cookie },
    });
    expect(list.json().documents).toHaveLength(0);

    const download = await h.app.inject({
      method: 'GET',
      url: `/api/documents/${documentId}/download`,
      headers: { cookie: alice.cookie },
    });
    expect(download.statusCode).toBe(404);

    expect((await h.app.inject({ method: 'GET', url: `/api/shares/${token}` })).statusCode).toBe(410);
  });
});
