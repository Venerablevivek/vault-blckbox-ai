import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { hashPassword } from './modules/auth/password';
import { generateToken, hashToken } from './lib/tokens';
import { documentObjectKey } from './storage/keys';
import type { FileStorage } from './storage/file-storage';

/**
 * Idempotent demo seed so a reviewer sees a working application immediately after
 * `docker compose up --build`, rather than an empty state and a sign-up form.
 *
 * Never run with SEED_DEMO_DATA unset/false (the default outside development).
 */
export const DEMO_USERS = [
  { email: 'alice@example.com', password: 'password123' },
  { email: 'bob@example.com', password: 'password123' },
];

const SAMPLE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8',
);

const SAMPLE_CSV = Buffer.from('quarter,revenue\nQ1,120000\nQ2,138500\nQ3,151200\n', 'utf8');

export async function seedDemoData(pool: Pool, storage: FileStorage, logger: Logger, webUrl: string): Promise<void> {
  const { rows: existing } = await pool.query('SELECT 1 FROM users LIMIT 1');
  if (existing.length > 0) {
    logger.info('demo seed skipped (database already has users)');
    return;
  }

  const passwordHash = await hashPassword(DEMO_USERS[0]!.password);

  const aliceId = randomUUID();
  const bobId = randomUUID();
  const personalId = randomUUID();
  const sharedId = randomUUID();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ($1, $2, $4, now()), ($3, $5, $4, now())`,
      [aliceId, DEMO_USERS[0]!.email, bobId, passwordHash, DEMO_USERS[1]!.email],
    );

    await client.query(
      `INSERT INTO workspaces (id, name, created_by) VALUES ($1, 'My Workspace', $3), ($2, 'Marketing', $3)`,
      [personalId, sharedId, aliceId],
    );

    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $3, 'OWNER'), ($2, $3, 'OWNER'), ($2, $4, 'MEMBER')`,
      [personalId, sharedId, aliceId, bobId],
    );

    const documents = [
      { name: 'Q3-forecast.csv', mime: 'text/csv', body: SAMPLE_CSV, workspace: sharedId },
      { name: 'Brand-guide.pdf', mime: 'application/pdf', body: SAMPLE_PDF, workspace: sharedId },
      { name: 'Notes.pdf', mime: 'application/pdf', body: SAMPLE_PDF, workspace: personalId },
    ];

    let firstDocumentId = '';
    for (const doc of documents) {
      const id = randomUUID();
      if (!firstDocumentId) firstDocumentId = id;
      const key = documentObjectKey(doc.workspace, id);
      await storage.upload(key, Readable.from(doc.body), doc.mime);
      await client.query(
        `INSERT INTO documents (id, workspace_id, uploaded_by, filename, storage_key, mime_type, size)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, doc.workspace, aliceId, doc.name, key, doc.mime, doc.body.length],
      );
    }

    // One live share link, so the public page can be demonstrated without creating one.
    const shareToken = generateToken('shr');
    await client.query(
      `INSERT INTO shares (id, document_id, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, now() + interval '7 days', $4)`,
      [randomUUID(), firstDocumentId, hashToken(shareToken), aliceId],
    );

    // One pending invitation, so the invite flow can be demonstrated too.
    const inviteToken = generateToken('inv');
    await client.query(
      `INSERT INTO invitations (id, workspace_id, email, token_hash, role, expires_at, created_by)
       VALUES ($1, $2, 'carol@example.com', $3, 'MEMBER', now() + interval '7 days', $4)`,
      [randomUUID(), sharedId, hashToken(inviteToken), aliceId],
    );

    await client.query('COMMIT');

    logger.info(
      {
        users: DEMO_USERS.map((u) => u.email),
        password: DEMO_USERS[0]!.password,
        shareLink: `${webUrl}/s/${shareToken}`,
        inviteLink: `${webUrl}/invite/${inviteToken}`,
      },
      'demo data seeded',
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
