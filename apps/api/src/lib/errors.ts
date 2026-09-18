/**
 * Every failure the API returns on purpose is an AppError. Anything else becomes an
 * opaque 500 in the error plugin, so stack traces, SQL and driver messages never
 * reach a client.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    /** Extra response headers, e.g. Retry-After on a 429 or 503. */
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

function formatMb(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export const Errors = {
  unauthorized: () => new AppError(401, 'UNAUTHORIZED', 'Authentication required.'),
  invalidCredentials: () => new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.'),

  /**
   * Used when the caller is authenticated but is not a member of the workspace.
   *
   * This is deliberately 404 and not 403: a 403 would confirm that the workspace or
   * document exists, which turns the API into an existence oracle. Non-members get
   * exactly the same answer as they would for an id that never existed.
   */
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`),

  /** Caller IS a member but lacks the role. They already know it exists, so 403 is honest. */
  forbidden: (message = 'You do not have permission to do that.') => new AppError(403, 'FORBIDDEN', message),

  conflict: (code: string, message: string) => new AppError(409, code, message),

  /**
   * Share link was real but is no longer usable. 410 rather than 404 so the recipient
   * knows the link was genuine and can ask the sender for a new one.
   */
  gone: (message = 'This link is no longer available.') => new AppError(410, 'SHARE_UNAVAILABLE', message),

  payloadTooLarge: (maxBytes: number) =>
    new AppError(413, 'FILE_TOO_LARGE', `File exceeds the maximum size of ${maxBytes} bytes.`),

  /** The workspace has no room for the file. 413 like an oversize file: the upload is refused for its size. */
  quotaExceeded: (usedBytes: number, quotaBytes: number) =>
    new AppError(
      413,
      'QUOTA_EXCEEDED',
      `This workspace has no room for that file (${formatMb(usedBytes)} of ${formatMb(quotaBytes)} used). Empty the trash or remove files first.`,
    ),

  unsupportedMediaType: (message: string) => new AppError(415, 'UNSUPPORTED_FILE_TYPE', message),

  badRequest: (code: string, message: string) => new AppError(400, code, message),

  /** 401 with a specific code, for public routes that need a credential other than a session. */
  credentialRequired: (code: string, message: string) => new AppError(401, code, message),

  unprocessable: (code: string, message: string) => new AppError(422, code, message),

  tooManyRequests: (code: string, message: string, retryAfterSeconds: number) =>
    new AppError(429, code, message, { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) }),

  /** The account hasn't confirmed its email address yet. */
  emailNotVerified: (action: string) =>
    new AppError(
      403,
      'EMAIL_NOT_VERIFIED',
      `Confirm your email address before you ${action}. Check your inbox, or resend the email from the banner.`,
    ),

  notImplemented: (message: string) => new AppError(501, 'NOT_IMPLEMENTED', message),

  /** The request is fine but the server is at capacity; the client should retry shortly. */
  busy: (code: string, message: string, retryAfterSeconds: number) =>
    new AppError(503, code, message, { 'Retry-After': String(retryAfterSeconds) }),
};
