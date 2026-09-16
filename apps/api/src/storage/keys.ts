/**
 * The only place object keys are constructed.
 *
 * Keys are built solely from server-generated UUIDs. No part of a key comes from the
 * user, so a filename like "../../etc/passwd" cannot influence where an object lands —
 * path traversal is impossible by construction rather than sanitised away.
 *
 * The original filename is stored in the documents row and re-attached at download time
 * through Content-Disposition.
 */
export function documentObjectKey(workspaceId: string, documentId: string): string {
  return `workspaces/${workspaceId}/documents/${documentId}`;
}
