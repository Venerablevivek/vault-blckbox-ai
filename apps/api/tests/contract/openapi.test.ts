import { readFileSync } from 'node:fs';
import path from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allOperations, buildOpenApiDocument } from '../../src/openapi/document';
import { createHarness, registerUser, SAMPLE_PDF, uploadDocument, type Harness } from '../helpers/harness';

/**
 * The OpenAPI document is generated from the same Zod schemas the routes validate with. These
 * tests keep it honest: it lists exactly the routes the server has, it is valid OpenAPI, the
 * committed copy is current, and real responses match the documented success schemas
 * (response schemas reject unknown fields, so an undocumented field fails too).
 */
describe('API contract', () => {
  let h: Harness;
  const covered = new Set<string>();

  beforeAll(async () => {
    h = await createHarness();
    await h.truncate();
  });
  afterAll(async () => h.close());

  const key = (method: string, url: string) => `${method.toUpperCase()} ${url}`;

  /** Checks a response against the operation's documented success status and schema. */
  function expectContract(
    method: string,
    template: string,
    response: { statusCode: number; body: string; headers: Record<string, unknown> },
  ) {
    const op = allOperations.find((o) => o.method === method.toLowerCase() && o.path === template);
    expect(op, `${key(method, template)} is not documented`).toBeDefined();
    covered.add(key(method, template));
    if (op!.success === 'stream') {
      // Streams are exercised in tests/integration/notification-stream.test.ts; inject can't hold one open.
      return;
    }
    if (op!.success === 'redirect') {
      expect(response.statusCode, response.body).toBe(302);
      expect(String(response.headers.location)).toMatch(/^https?:\/\//);
      return;
    }
    const [status, schema] = op!.success;
    expect(response.statusCode, `${key(method, template)}: ${response.body}`).toBe(status);
    if (schema === null) {
      expect(response.body).toBe('');
      return;
    }
    const parsed = schema.safeParse(JSON.parse(response.body));
    expect(
      parsed.success,
      `${key(method, template)} response does not match its schema: ${parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)}`,
    ).toBe(true);
  }

  const send = (method: string, url: string, cookie?: string, payload?: unknown) =>
    h.app.inject({
      method: method as 'GET',
      url,
      headers: cookie ? { cookie } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  it('documents exactly the routes the server registers', () => {
    const server = new Set(h.app.routeTable.map((r) => key(r.method, r.url)));
    const documented = new Set(allOperations.map((o) => key(o.method, o.path)));
    expect(
      [...server].filter((r) => !documented.has(r)),
      'registered but not documented',
    ).toEqual([]);
    expect(
      [...documented].filter((r) => !server.has(r)),
      'documented but not registered',
    ).toEqual([]);
  });

  it('is a valid OpenAPI 3.1 document', async () => {
    const document = buildOpenApiDocument();
    await expect(SwaggerParser.validate(structuredClone(document) as never)).resolves.toBeDefined();
  });

  it('matches the committed openapi.json (run `npm run openapi` after changing a contract)', () => {
    const committed = JSON.parse(readFileSync(path.resolve(__dirname, '../../openapi.json'), 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });

  it('serves the same routes under /api/v1', async () => {
    const alice = await registerUser(h.app, 'v1@example.com');
    const unversioned = await send('GET', '/api/auth/me', alice.cookie);
    const versioned = await send('GET', '/api/v1/auth/me', alice.cookie);
    expect(versioned.statusCode).toBe(200);
    expect(versioned.json()).toEqual(unversioned.json());
    expect((await send('GET', '/api/v1/openapi.json')).statusCode).toBe(200);
  });

  it('returns responses that match the documented schemas, for every operation', async () => {
    await h.truncate();
    const ok = (m: string, t: string, r: Parameters<typeof expectContract>[2]) => expectContract(m, t, r);

    expectContract('GET', '/health', await send('GET', '/health'));
    expectContract('GET', '/ready', await send('GET', '/ready'));
    expectContract('GET', '/api/openapi.json', await send('GET', '/api/openapi.json'));

    // Accounts
    const register = await send('POST', '/api/auth/register', undefined, {
      email: 'owner@example.com',
      password: 'password123',
    });
    ok('POST', '/api/auth/register', register);
    const login = await send('POST', '/api/auth/login', undefined, {
      email: 'owner@example.com',
      password: 'password123',
    });
    ok('POST', '/api/auth/login', login);
    const cookie = String(([] as string[]).concat(login.headers['set-cookie'] as string)[0]).split(';')[0]!;
    const me = await send('GET', '/api/auth/me', cookie);
    ok('GET', '/api/auth/me', me);
    const workspaceId = me.json().workspaces[0].id as string;
    const userId = me.json().user.id as string;

    const sessions = await send('GET', '/api/auth/sessions', cookie);
    ok('GET', '/api/auth/sessions', sessions);
    const other = sessions.json().sessions.find((s: { current: boolean }) => !s.current);
    ok('DELETE', '/api/auth/sessions/:sessionId', await send('DELETE', `/api/auth/sessions/${other.id}`, cookie));
    ok('DELETE', '/api/auth/sessions', await send('DELETE', '/api/auth/sessions', cookie));
    ok(
      'POST',
      '/api/auth/password',
      await send('POST', '/api/auth/password', cookie, { currentPassword: 'password123', newPassword: 'password456' }),
    );
    ok(
      'POST',
      '/api/auth/password/forgot',
      await send('POST', '/api/auth/password/forgot', undefined, { email: 'owner@example.com' }),
    );
    const resetMail = await h.mailer.waitFor((m) => m.subject.includes('Reset'));
    const resetToken = /token=(pwr_[\w-]+)/.exec(resetMail.text)![1]!;
    const reset = await send('POST', '/api/auth/password/reset', undefined, {
      token: resetToken,
      password: 'password789',
    });
    ok('POST', '/api/auth/password/reset', reset);
    const owner = String(([] as string[]).concat(reset.headers['set-cookie'] as string)[0]).split(';')[0]!;

    // Workspaces and members
    ok('GET', '/api/workspaces', await send('GET', '/api/workspaces', owner));
    const created = await send('POST', '/api/workspaces', owner, { name: 'Spare' });
    ok('POST', '/api/workspaces', created);
    ok('PATCH', '/api/workspaces/:id', await send('PATCH', `/api/workspaces/${workspaceId}`, owner, { name: 'Legal' }));
    ok('GET', '/api/workspaces/:id/storage', await send('GET', `/api/workspaces/${workspaceId}/storage`, owner));

    const member = await registerUser(h.app, 'member@example.com');
    const invite = await send('POST', `/api/workspaces/${workspaceId}/invitations`, owner, {
      email: 'member@example.com',
      role: 'MEMBER',
    });
    ok('POST', '/api/workspaces/:id/invitations', invite);
    const inviteToken = invite.json().inviteUrl.split('/invite/')[1];
    ok('GET', '/api/invitations/:token', await send('GET', `/api/invitations/${inviteToken}`));
    ok(
      'POST',
      '/api/invitations/:token/accept',
      await send('POST', `/api/invitations/${inviteToken}/accept`, member.cookie),
    );
    const pending = await send('POST', `/api/workspaces/${workspaceId}/invitations`, owner, {
      email: 'pending@example.com',
      role: 'VIEWER',
    });
    ok('GET', '/api/workspaces/:id/members', await send('GET', `/api/workspaces/${workspaceId}/members`, owner));
    ok(
      'DELETE',
      '/api/workspaces/:id/invitations/:invitationId',
      await send('DELETE', `/api/workspaces/${workspaceId}/invitations/${pending.json().invitation.id}`, owner),
    );
    ok(
      'PATCH',
      '/api/workspaces/:id/members/:userId',
      await send('PATCH', `/api/workspaces/${workspaceId}/members/${member.userId}`, owner, { role: 'OWNER' }),
    );

    // Folders and documents
    const folder = await send('POST', `/api/workspaces/${workspaceId}/folders`, owner, { name: 'Contracts' });
    ok('POST', '/api/workspaces/:workspaceId/folders', folder);
    const folderId = folder.json().folder.id;
    ok(
      'GET',
      '/api/workspaces/:workspaceId/folders',
      await send('GET', `/api/workspaces/${workspaceId}/folders`, owner),
    );
    ok(
      'PATCH',
      '/api/workspaces/:workspaceId/folders/:folderId',
      await send('PATCH', `/api/workspaces/${workspaceId}/folders/${folderId}`, owner, { name: 'Signed contracts' }),
    );

    // Direct upload: start, sign, PUT to storage, check status, complete; and a cancelled one.
    const direct = await send('POST', `/api/workspaces/${workspaceId}/uploads`, owner, {
      filename: 'direct.pdf',
      size: SAMPLE_PDF.length,
      mimeType: 'application/pdf',
    });
    ok('POST', '/api/workspaces/:workspaceId/uploads', direct);
    const uploadId = direct.json().upload.id;
    const signed = await send('POST', `/api/uploads/${uploadId}/parts`, owner, { partNumbers: [1] });
    ok('POST', '/api/uploads/:id/parts', signed);
    await fetch(signed.json().parts[0].url, { method: 'PUT', body: SAMPLE_PDF });
    ok('GET', '/api/uploads/:id', await send('GET', `/api/uploads/${uploadId}`, owner));
    ok('POST', '/api/uploads/:id/complete', await send('POST', `/api/uploads/${uploadId}/complete`, owner));
    const cancelled = await send('POST', `/api/workspaces/${workspaceId}/uploads`, owner, {
      filename: 'cancel.pdf',
      size: 10,
      mimeType: 'application/pdf',
    });
    ok('DELETE', '/api/uploads/:id', await send('DELETE', `/api/uploads/${cancelled.json().upload.id}`, owner));

    const upload = await uploadDocument(h.app, owner, workspaceId, 'msa.pdf', SAMPLE_PDF);
    ok('POST', '/api/workspaces/:workspaceId/documents', upload);
    const documentId = upload.json().document.id;
    ok('PATCH', '/api/documents/:id', await send('PATCH', `/api/documents/${documentId}`, owner, { folderId }));
    ok('PUT', '/api/documents/:id/star', await send('PUT', `/api/documents/${documentId}/star`, owner));
    ok('DELETE', '/api/documents/:id/star', await send('DELETE', `/api/documents/${documentId}/star`, owner));
    ok('GET', '/api/documents/:id/download', await send('GET', `/api/documents/${documentId}/download`, owner));
    ok('GET', '/api/documents/:id/preview', await send('GET', `/api/documents/${documentId}/preview`, owner));

    // Sharing, including an unlocked and a locked public link
    const share = await send('POST', '/api/shares', owner, { documentId, maxDownloads: 5 });
    ok('POST', '/api/shares', share);
    const shareId = share.json().share.id;
    const token = share.json().share.url.split('/s/')[1];
    ok('GET', '/api/shares/:token', await send('GET', `/api/shares/${token}`));
    ok('POST', '/api/shares/:token/view', await send('POST', `/api/shares/${token}/view`));
    ok('GET', '/api/shares/:token/download', await send('GET', `/api/shares/${token}/download`));
    ok('PATCH', '/api/shares/:id', await send('PATCH', `/api/shares/${shareId}`, owner, { password: 'open-sesame' }));
    const locked = await send('GET', `/api/shares/${token}`);
    ok('GET', '/api/shares/:token', locked);
    expect(locked.json().requiresPassword).toBe(true);
    ok(
      'POST',
      '/api/shares/:token/unlock',
      await send('POST', `/api/shares/${token}/unlock`, undefined, { password: 'open-sesame' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    ok('GET', '/api/documents/:id/shares', await send('GET', `/api/documents/${documentId}/shares`, owner));
    ok('GET', '/api/shares/:id/events', await send('GET', `/api/shares/${shareId}/events`, owner));
    ok('DELETE', '/api/shares/:id', await send('DELETE', `/api/shares/${shareId}`, owner));

    ok(
      'GET',
      '/api/workspaces/:workspaceId/documents',
      await send('GET', `/api/workspaces/${workspaceId}/documents?q=msa`, owner),
    );
    ok(
      'GET',
      '/api/workspaces/:id/overview',
      await send('GET', `/api/workspaces/${workspaceId}/overview?tz=Europe/London`, owner),
    );
    ok('GET', '/api/workspaces/:id/audit', await send('GET', `/api/workspaces/${workspaceId}/audit`, owner));
    ok(
      'GET',
      '/api/workspaces/:id/audit/verify',
      await send('GET', `/api/workspaces/${workspaceId}/audit/verify`, owner),
    );
    ok('GET', '/api/notifications', await send('GET', '/api/notifications', member.cookie));
    ok('POST', '/api/notifications/read', await send('POST', '/api/notifications/read', member.cookie, {}));

    ok('DELETE', '/api/documents/:id', await send('DELETE', `/api/documents/${documentId}`, owner));
    ok('POST', '/api/documents/:id/restore', await send('POST', `/api/documents/${documentId}/restore`, owner));
    await send('DELETE', `/api/documents/${documentId}`, owner);
    ok('DELETE', '/api/documents/:id/permanent', await send('DELETE', `/api/documents/${documentId}/permanent`, owner));
    ok(
      'DELETE',
      '/api/workspaces/:workspaceId/folders/:folderId',
      await send('DELETE', `/api/workspaces/${workspaceId}/folders/${folderId}`, owner),
    );
    ok(
      'DELETE',
      '/api/workspaces/:id/members/:userId',
      await send('DELETE', `/api/workspaces/${workspaceId}/members/${member.userId}`, owner),
    );
    ok(
      'DELETE',
      '/api/workspaces/:id',
      await send('DELETE', `/api/workspaces/${created.json().workspace.id}`, owner, { confirmName: 'Spare' }),
    );
    // Email verification: an unverified account asks for a new link and follows it.
    const unverified = await registerUser(h.app, 'unverified@example.com');
    await h.query('UPDATE users SET email_verified_at = NULL WHERE id = $1', [unverified.userId]);
    ok('POST', '/api/auth/email/resend', await send('POST', '/api/auth/email/resend', unverified.cookie));
    const confirmMail = await h.mailer.waitFor((m) => m.to === 'unverified@example.com');
    const verifyToken = /token=(evt_[\w-]+)/.exec(confirmMail.text)![1]!;
    ok(
      'POST',
      '/api/auth/email/verify',
      await send('POST', '/api/auth/email/verify', undefined, { token: verifyToken }),
    );

    // A stream can't be read through inject; its behaviour is covered in notification-stream.test.ts.
    ok('GET', '/api/notifications/stream', { statusCode: 200, body: '', headers: {} });
    ok('POST', '/api/auth/logout', await send('POST', '/api/auth/logout', owner));
    void userId;

    const untested = allOperations.map((o) => key(o.method, o.path)).filter((k) => !covered.has(k));
    expect(untested, 'operations without a contract check').toEqual([]);
  });

  it('documents error responses with the shared error shape', async () => {
    const response = await send('GET', '/api/auth/me');
    expect(response.statusCode).toBe(401);
    const { ErrorBody } = await import('../../src/contracts/common');
    expect(ErrorBody.safeParse(response.json()).success).toBe(true);
    const invalid = await send('POST', '/api/auth/login', undefined, { email: 'not-an-email' });
    expect(invalid.statusCode).toBe(400);
    expect(ErrorBody.safeParse(invalid.json()).success).toBe(true);
  });
});
