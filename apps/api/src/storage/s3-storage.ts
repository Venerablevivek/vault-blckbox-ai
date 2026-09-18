import {
  CopyObjectCommand,
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type Part,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { Config } from '../config';
import type { FileStorage, SignedUrlOptions } from './file-storage';
import type { MultipartStorage, UploadedPart } from './multipart-storage';

export interface S3StorageOptions {
  endpoint: string; // internal: how the API reaches MinIO (e.g. http://minio:9000)
  publicEndpoint: string; // public:   what the browser can resolve (e.g. http://localhost:9000)
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * MinIO / S3 implementation.
 *
 * Two clients, on purpose. An S3 signature covers the Host header, so a URL signed for
 * `minio:9000` fails with SignatureDoesNotMatch when the browser (which cannot resolve
 * that name) requests it from `localhost:9000`. String-replacing the host afterwards
 * breaks the signature too. The fix is to sign against the public endpoint from the
 * start, while server-side operations keep using the internal one.
 */
export class S3Storage implements FileStorage, MultipartStorage {
  static fromConfig(config: Config): S3Storage {
    return new S3Storage({
      endpoint: config.S3_ENDPOINT,
      publicEndpoint: config.S3_PUBLIC_ENDPOINT,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET,
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    });
  }

  private readonly internal: S3Client;
  private readonly signer: S3Client;
  private readonly bucket: string;

  constructor(private readonly options: S3StorageOptions) {
    const shared = {
      region: options.region,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      // MinIO serves path-style buckets (http://host/bucket/key), not virtual-hosted.
      forcePathStyle: true,
    };

    this.internal = new S3Client({ ...shared, endpoint: options.endpoint });
    this.signer = new S3Client({ ...shared, endpoint: options.publicEndpoint });
    this.bucket = options.bucket;
  }

  /**
   * Creates the bucket if it does not exist. Called once at boot so `docker compose up`
   * needs no manual bucket creation and no extra init container.
   *
   * The bucket is left with MinIO's default policy, which is private. We never apply a
   * public read policy: the only way to reach an object is a short-lived signed URL.
   */
  async ensureBucket(): Promise<void> {
    try {
      await this.internal.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.internal.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async upload(key: string, stream: Readable, contentType: string): Promise<void> {
    // The multipart parser has already buffered/limited the part, so ContentLength is
    // known by the caller; passing the stream straight through keeps the API out of the
    // business of re-buffering the whole file.
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    await this.internal.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      }),
    );
  }

  async download(key: string): Promise<Readable> {
    const result = await this.internal.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return result.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    await this.internal.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Copies an object inside the bucket, on the storage side: no bytes pass through the API. */
  async copy(sourceKey: string, targetKey: string): Promise<void> {
    await this.internal.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: targetKey,
        // The source is "<bucket>/<key>", URL-encoded. Keys here are UUID paths, but encode anyway.
        CopySource: `${this.bucket}/${encodeKey(sourceKey)}`,
      }),
    );
  }

  async getSignedUrl(key: string, expiresIn: number, options?: SignedUrlOptions): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      // Force a download rather than inline rendering. Combined with serving from the
      // MinIO origin (never the app origin), an uploaded HTML or SVG file can never
      // execute against a session cookie.
      ResponseContentDisposition: options?.filename
        ? `${options.disposition ?? 'attachment'}; filename*=UTF-8''${encodeURIComponent(options.filename)}`
        : (options?.disposition ?? 'attachment'),
      ...(options?.contentType ? { ResponseContentType: options.contentType } : {}),
    });

    return presign(this.signer, command, { expiresIn });
  }

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const result = await this.internal.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!result.UploadId) throw new Error('storage did not return an upload id');
    return result.UploadId;
  }

  async signUploadPart(key: string, uploadId: string, partNumber: number, expiresInSeconds: number): Promise<string> {
    // Signed against the public endpoint, like download URLs: the browser sends the PUT.
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    return presign(this.signer, command, { expiresIn: expiresInSeconds });
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    // ListParts returns at most 1,000 parts per call; an upload can have 10,000.
    for (;;) {
      const page = await this.internal.send(
        new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
      );
      for (const part of page.Parts ?? []) {
        if (part.PartNumber && part.ETag)
          parts.push({ partNumber: part.PartNumber, etag: part.ETag, size: part.Size ?? 0 });
      }
      if (!page.IsTruncated || !page.NextPartNumberMarker) break;
      marker = page.NextPartNumberMarker;
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<void> {
    const sorted: Part[] = [...parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag }));
    await this.internal.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: sorted },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internal.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
    } catch (error) {
      if ((error as { name?: string }).name !== 'NoSuchUpload') throw error;
    }
  }

  async headObject(key: string): Promise<{ size: number } | null> {
    try {
      const result = await this.internal.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: result.ContentLength ?? 0 };
    } catch (error) {
      const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }

  async readRange(key: string, start: number, end: number): Promise<Buffer> {
    const result = await this.internal.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${end}` }),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of result.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}
