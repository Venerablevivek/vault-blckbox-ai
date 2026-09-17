import { obj, Role, timestamp, uuid, z } from './common';

// 8 characters is the floor; Argon2id does the heavy lifting from there.
export const password = z.string().min(8).max(200);
const email = z.string().email().max(255);

export const CredentialsBody = z.object({ email, password }).openapi('Credentials');
export const RegisterBody = CredentialsBody.extend({ inviteToken: z.string().max(200).optional() }).openapi('RegisterRequest');
export const ForgotPasswordBody = z.object({ email }).openapi('ForgotPasswordRequest');
export const ResetPasswordBody = z.object({ token: z.string().min(10).max(200), password }).openapi('ResetPasswordRequest');
export const ChangePasswordBody = z
  .object({ currentPassword: z.string().min(1).max(200), newPassword: password })
  .openapi('ChangePasswordRequest');
export const SessionParams = obj({ sessionId: uuid });

export const User = obj({ id: uuid, email: z.string() }).openapi('User');
export const WorkspaceSummary = obj({ id: uuid, name: z.string(), role: Role }).openapi('WorkspaceSummary');

export const UserResponse = obj({ user: User });
export const MeResponse = obj({ user: User, workspaces: z.array(WorkspaceSummary) }).openapi('Me');
export const MessageResponse = obj({ message: z.string() });
export const ResetPasswordResponse = obj({ user: User, signedOutSessions: z.number().int().nonnegative() });
export const SignedOutResponse = obj({ signedOutSessions: z.number().int().nonnegative() });

export const Session = obj({
  id: uuid,
  userAgent: z.string().nullable(),
  createdAt: timestamp,
  lastSeenAt: timestamp,
  expiresAt: timestamp,
  current: z.boolean(),
}).openapi('Session');
export const SessionsResponse = obj({ sessions: z.array(Session) });
