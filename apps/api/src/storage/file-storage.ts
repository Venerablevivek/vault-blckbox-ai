import type { Readable } from 'node:stream';

/**
 * The storage boundary, exactly as specified in the blueprint.
 *
 * Business logic never imports the AWS SDK; it depends only on this interface. Swapping
 * MinIO for AWS S3 is an environment change, and swapping for another provider entirely
 * is one new file implementing these four methods.
 */
export interface FileStorage {
  upload(key: string, stream: Readable, contentType: string): Promise<void>;
  download(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresIn: number, options?: SignedUrlOptions): Promise<string>;
  /** Optional: a copy made by the store itself. Without it, callers stream the bytes through. */
  copy?(sourceKey: string, targetKey: string): Promise<void>;
}

export interface SignedUrlOptions {
  /** Filename presented to the browser via Content-Disposition. */
  filename?: string;
  contentType?: string;
  /**
   * `attachment` (default) forces a download. `inline` lets the browser render the file,
   * and is only ever requested for types that cannot execute script (PDF, raster images).
   */
  disposition?: 'attachment' | 'inline';
}
