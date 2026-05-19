import { UserPlan } from '@prisma/client';

/**
 * Days a soft-deleted file stays recoverable before the cron worker
 * removes it from R2 and the database.
 */
export const TRASH_RETENTION_DAYS = 30;

/**
 * Maximum single file size (bytes) by user plan.
 * Mirrors the table in README.md → File Storage Plans.
 */
export const FILE_SIZE_LIMITS: Record<UserPlan, number> = {
  FREE: 25 * 1024 * 1024, // 25 MB
  PRO: 100 * 1024 * 1024, // 100 MB
  BUSINESS: 500 * 1024 * 1024, // 500 MB
};

/**
 * Maximum total storage per workspace (bytes), enforced against the workspace owner's plan.
 */
export const STORAGE_LIMITS: Record<UserPlan, number> = {
  FREE: 500 * 1024 * 1024, // 500 MB
  PRO: 10 * 1024 * 1024 * 1024, // 10 GB
  BUSINESS: 50 * 1024 * 1024 * 1024, // 50 GB
};

/**
 * MIME types accepted on upload. Server-side detection (file-type) checks the actual
 * bytes match this list — client-supplied Content-Type is not trusted.
 *
 * Audio and executables are intentionally excluded.
 */
export const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/rtf',
  'text/plain',
  'text/markdown',

  // Spreadsheets
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/csv',

  // Presentations
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.apple.keynote',

  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'image/heic',
  'image/heif',

  // Design files (most served as octet-stream; rely on extension as fallback)
  'application/postscript', // .ai
  'application/x-photoshop', // .psd (some servers)
  'image/vnd.adobe.photoshop', // .psd (modern)
  'application/x-sketch', // .sketch
  'application/octet-stream', // generic — accept, but extension allowlist still applies

  // Archives
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/gzip',
  'application/x-tar',

  // Data
  'application/json',
  'application/xml',
  'text/xml',

  // Video (screen recordings, walkthroughs)
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

/**
 * Text-based formats that `file-type` cannot detect from magic bytes (no signature).
 * For these, we fall back to: extension allowlist + client MIME + null-byte sanity check.
 */
export const TEXT_BASED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.xml',
  '.svg',
  '.rtf',
]);

export const TEXT_BASED_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'text/xml',
  'image/svg+xml',
  'application/rtf',
]);

/**
 * Allowed file extensions (lowercase, including dot). Belt-and-suspenders alongside MIME check.
 */
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  // Documents
  '.pdf',
  '.doc',
  '.docx',
  '.txt',
  '.md',
  '.rtf',

  // Spreadsheets
  '.xls',
  '.xlsx',
  '.csv',
  '.ods',

  // Presentations
  '.ppt',
  '.pptx',
  '.key',

  // Images
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.heic',
  '.heif',

  // Design files
  '.psd',
  '.ai',
  '.sketch',
  '.fig',
  '.xd',
  '.indd',

  // Archives
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',

  // Data
  '.json',
  '.xml',

  // Video
  '.mp4',
  '.mov',
  '.webm',
]);
