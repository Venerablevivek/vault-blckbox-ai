import { randomUUID } from 'node:crypto';

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

/**
 * A later version of a document. Not under the document's own key: on a file-system backed store
 * (MinIO) an object can't also be a directory, so `.../documents/<id>` and `.../documents/<id>/x`
 * could not both exist.
 */
export function documentVersionObjectKey(workspaceId: string, documentId: string, versionId: string): string {
  return `workspaces/${workspaceId}/versions/${documentId}/${versionId}`;
}

/** Something derived from a document (a thumbnail, an Office file's PDF preview). A new key each time. */
export function derivedObjectKey(workspaceId: string, documentId: string, extension: 'webp' | 'pdf'): string {
  return `workspaces/${workspaceId}/derived/${documentId}/${randomUUID()}.${extension}`;
}
