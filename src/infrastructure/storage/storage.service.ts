import { Injectable, Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service';
import { ServiceUnavailableException } from '../../core/exceptions/app.exception';

export type StorageBucket = 'avatars' | 'kyc' | 'reports';

export interface UploadFileInput {
  bucket: StorageBucket;
  /** Logical folder prefix within the bucket, e.g. `userId` or `userId/national-id`. */
  keyPrefix: string;
  fileName: string;
  contentType: string;
  body: Buffer;
}

export interface UploadFileResult {
  key: string;
  bucket: string;
  /** ETag reported by the store — used as a cheap integrity check. */
  etag?: string;
}

/**
 * Thin, provider-agnostic wrapper around the AWS S3 SDK — works
 * identically against AWS S3, Cloudflare R2, or a self-hosted MinIO
 * instance, since all three speak the S3 API. Selected via
 * `STORAGE_PROVIDER` + `STORAGE_ENDPOINT` in config; no other code in
 * the app needs to know which one is in use.
 *
 * Files are NEVER stored on the application's own filesystem/disk —
 * every upload (avatars, KYC documents, proof of residence, generated
 * reports) streams straight to object storage. KYC documents live in a
 * private bucket and are only ever exposed via short-lived signed URLs
 * (`STORAGE_SIGNED_URL_TTL_SECONDS`), never a public/direct URL.
 *
 * Virus scanning: `scanBuffer` is a hook point — Phase 3 (KYC module)
 * wires this to a real scanner (e.g. ClamAV sidecar or a cloud AV API)
 * before a KYC upload is accepted; left as an explicit interface here
 * so the call site is unambiguous rather than silently skipped.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;

  constructor(private readonly config: AppConfigService) {
    const { endpoint, region, accessKeyId, secretAccessKey, forcePathStyle } = config.storage;

    this.client = new S3Client({
      endpoint,
      region,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async upload(input: UploadFileInput): Promise<UploadFileResult> {
    const key = this.buildKey(input.keyPrefix, input.fileName);
    const bucketName = this.resolveBucketName(input.bucket);

    this.logger.debug(
      `Uploading to ${bucketName}/${key} (${input.contentType}, ${input.body.byteLength} bytes)`,
    );

    try {
      const result = await this.client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: input.body,
          ContentType: input.contentType,
        }),
      );

      this.logger.log(`Upload successful: ${bucketName}/${key}`);
      return { key, bucket: bucketName, etag: result.ETag };
    } catch (error: any) {
      this.logger.error(
        {
          err: error,
          bucket: bucketName,
          key,
          code: error?.Code ?? error?.$metadata?.httpStatusCode,
          s3Message: error?.message,
          endpoint: this.config.storage.endpoint,
        },
        'Object storage upload failed',
      );
      throw new ServiceUnavailableException('File upload failed, please try again');
    }
  }

  /**
   * Generate a presigned GET URL for a stored object.
   *
   * @param bucket        Logical bucket name
   * @param key           Object key within the bucket
   * @param expiresIn     TTL in seconds. Defaults to `STORAGE_SIGNED_URL_TTL_SECONDS`
   *                      from config. KYC document review requests pass 3 600 (1 h)
   *                      so the admin can open images after the detail endpoint
   *                      has already been fetched.
   */
  async getSignedDownloadUrl(
    bucket: StorageBucket,
    key: string,
    expiresIn?: number,
  ): Promise<string> {
    const bucketName = this.resolveBucketName(bucket);
    const command = new GetObjectCommand({ Bucket: bucketName, Key: key });

    let url = await getSignedUrl(this.client, command, {
      expiresIn: expiresIn ?? this.config.storage.signedUrlTtlSeconds,
    });

    // Rewrite internal Docker endpoint (e.g. http://minio:9000) to the
    // public-facing endpoint so browsers can actually reach the URL.
    // Use URL-object parsing instead of simple string replacement so that
    // the endpoint string can never accidentally match a substring of the
    // S3 key or query params (e.g. a key that happens to contain the host).
    const internalEndpoint = this.config.storage.endpoint;
    const publicEndpoint = this.config.storage.publicEndpoint;
    if (publicEndpoint && internalEndpoint && publicEndpoint !== internalEndpoint) {
      try {
        const parsedUrl = new URL(url);
        const parsedInternal = new URL(internalEndpoint);
        // Only rewrite if the signed URL's origin matches the internal endpoint
        if (parsedUrl.origin === parsedInternal.origin) {
          const parsedPublic = new URL(publicEndpoint);
          parsedUrl.protocol = parsedPublic.protocol;
          parsedUrl.hostname = parsedPublic.hostname;
          parsedUrl.port = parsedPublic.port;
          url = parsedUrl.toString();
        }
      } catch {
        // Malformed URL in config — fall back to literal replace as a last resort
        url = url.replace(internalEndpoint, publicEndpoint);
      }
    }

    return url;
  }

  async delete(bucket: StorageBucket, key: string): Promise<void> {
    const bucketName = this.resolveBucketName(bucket);
    await this.client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
  }

  async exists(bucket: StorageBucket, key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.resolveBucketName(bucket), Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private buildKey(prefix: string, fileName: string): string {
    const sanitized = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    return `${prefix}/${Date.now()}-${randomUUID()}-${sanitized}`;
  }

  private resolveBucketName(bucket: StorageBucket): string {
    return this.config.storage.buckets[bucket];
  }
}
