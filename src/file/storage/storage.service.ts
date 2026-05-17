/**
 * Abstract storage backend. Implementations: R2 (production), in-memory (tests).
 * Used as both the TypeScript type and the DI token.
 */
export abstract class StorageService {
  /**
   * Uploads a file under the given key. Overwrites if the key exists.
   */
  abstract upload(
    key: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<void>;

  /**
   * Returns a short-lived URL the client can use to download the object directly
   * from the storage backend (no server proxy).
   */
  abstract getDownloadUrl(
    key: string,
    expiresInSeconds?: number,
  ): Promise<string>;

  /**
   * Permanently removes the object from the storage backend.
   */
  abstract delete(key: string): Promise<void>;
}
