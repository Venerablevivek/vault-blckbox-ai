import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { Config } from '../config';
import type { FileStorage, SignedUrlOptions } from './file-storage';

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
export class S3Storage implements FileStorage {
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
}
