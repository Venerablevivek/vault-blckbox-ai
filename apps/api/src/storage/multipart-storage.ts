/**
 * Direct, resumable uploads from the browser to object storage (S3 multipart upload).
 *
 * Kept separate from FileStorage, the blueprint's four-method interface, because it is a
 * capability of S3-compatible stores specifically. The API never touches the bytes: it opens the
 * upload, signs short-lived URLs for each part, and verifies the result.
 */
export interface MultipartStorage {
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  /** A URL the browser PUTs one part to. S3 part numbers run from 1 to 10,000. */
  signUploadPart(key: string, uploadId: string, partNumber: number, expiresInSeconds: number): Promise<string>;
  /** Parts received so far, in part-number order. */
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<void>;
  /** Idempotent: aborting an upload that no longer exists is not an error. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  /** Size of a stored object, or null if there is none. */
  headObject(key: string): Promise<{ size: number } | null>;
  /** Bytes [start, end] inclusive, for checking a file's type without reading all of it. */
  readRange(key: string, start: number, end: number): Promise<Buffer>;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}
