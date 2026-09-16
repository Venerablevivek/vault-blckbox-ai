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
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthorized: () => new AppError(401, 'UNAUTHORIZED', 'Authentication required.'),
  invalidCredentials: () =>
    new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.'),

  /**
   * Used when the caller is authenticated but is not a member of the workspace.
   *
   * This is deliberately 404 and not 403: a 403 would confirm that the workspace or
   * document exists, which turns the API into an existence oracle. Non-members get
   * exactly the same answer as they would for an id that never existed.
   */
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`),

  /** Caller IS a member but lacks the role. They already know it exists, so 403 is honest. */
  forbidden: (message = 'You do not have permission to do that.') =>
    new AppError(403, 'FORBIDDEN', message),

  conflict: (code: string, message: string) => new AppError(409, code, message),

  /**
   * Share link was real but is no longer usable. 410 rather than 404 so the recipient
   * knows the link was genuine and can ask the sender for a new one.
   */
  gone: (message = 'This link is no longer available.') =>
    new AppError(410, 'SHARE_UNAVAILABLE', message),

  payloadTooLarge: (maxBytes: number) =>
    new AppError(413, 'FILE_TOO_LARGE', `File exceeds the maximum size of ${maxBytes} bytes.`),

  unsupportedMediaType: (message: string) =>
    new AppError(415, 'UNSUPPORTED_FILE_TYPE', message),

  badRequest: (code: string, message: string) => new AppError(400, code, message),
};
