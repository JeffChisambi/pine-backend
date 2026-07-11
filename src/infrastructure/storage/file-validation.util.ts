import { ValidationException } from '../../core/exceptions/app.exception';

/**
 * Defence in depth for uploads (avatars, KYC documents): the browser/app
 * -supplied `Content-Type` and file extension are both trivially
 * spoofable, so every upload is additionally checked against its actual
 * magic-byte signature before being accepted or forwarded to
 * `StorageService.upload`. Combined with the size limit and the virus
 * scan hook (`StorageService`), this is the full validation chain
 * required before any file reaches object storage.
 */
export interface FileSignature {
  mimeType: string;
  extensions: string[];
  /** Magic bytes the file must start with (hex). */
  signature: Buffer;
}

const ALLOWED_SIGNATURES: FileSignature[] = [
  {
    mimeType: 'image/jpeg',
    extensions: ['.jpg', '.jpeg'],
    signature: Buffer.from([0xff, 0xd8, 0xff]),
  },
  {
    mimeType: 'image/png',
    extensions: ['.png'],
    signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    mimeType: 'application/pdf',
    extensions: ['.pdf'],
    signature: Buffer.from([0x25, 0x50, 0x44, 0x46]),
  },
];

export interface FileValidationOptions {
  /** Restrict to a subset of the globally-allowed types, e.g. images only for avatars. */
  allowedMimeTypes?: string[];
  maxSizeBytes: number;
}

export function validateUploadedFile(
  fileName: string,
  declaredMimeType: string,
  buffer: Buffer,
  options: FileValidationOptions,
): void {
  if (buffer.byteLength === 0) {
    throw new ValidationException('Uploaded file is empty');
  }

  if (buffer.byteLength > options.maxSizeBytes) {
    throw new ValidationException(
      `File exceeds the maximum allowed size of ${(options.maxSizeBytes / (1024 * 1024)).toFixed(1)}MB`,
    );
  }

  const extension = extractExtension(fileName);
  const candidates = ALLOWED_SIGNATURES.filter(
    (sig) => sig.extensions.includes(extension) || sig.mimeType === declaredMimeType,
  );

  if (candidates.length === 0) {
    throw new ValidationException(
      `Unsupported file type: ${extension || 'unknown'} (${declaredMimeType})`,
    );
  }

  if (options.allowedMimeTypes && !options.allowedMimeTypes.includes(declaredMimeType)) {
    throw new ValidationException(
      `File type ${declaredMimeType} is not allowed for this upload target`,
    );
  }

  const matchesSignature = candidates.some((sig) =>
    buffer.subarray(0, sig.signature.length).equals(sig.signature),
  );

  if (!matchesSignature) {
    throw new ValidationException(
      'File content does not match its declared type (failed signature check)',
    );
  }
}

function extractExtension(fileName: string): string {
  const match = /\.[^./\\]+$/.exec(fileName.toLowerCase());
  return match ? match[0] : '';
}
