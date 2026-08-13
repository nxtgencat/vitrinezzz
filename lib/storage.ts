import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "./logger";

const storageDir = process.env.STORAGE_DIR ?? join("data", "storage");

const s3Enabled = Boolean(
  process.env.S3_ENDPOINT &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY &&
    process.env.S3_BUCKET,
);

/**
 * Storage adapter (`architecture.md` §4.10): `Bun.S3` when the S3 env vars are
 * set (MinIO-compatible), local `STORAGE_DIR` otherwise. The choice is a
 * boot-time environment check, not a code branch anywhere else — both paths
 * expose the same `put`/`get`/`delete` interface and both use the same
 * `media/<key>` keys (the `path`/`thumbPath` columns on the media row).
 */
export type StorageAdapter = {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
};

const s3 = s3Enabled
  ? new Bun.S3Client({
      endpoint: process.env.S3_ENDPOINT!,
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      bucket: process.env.S3_BUCKET!,
    })
  : null;

if (s3Enabled && s3) {
  logger.info("media storage: S3");
} else {
  logger.info({ storageDir }, "media storage: local");
}

export const storage: StorageAdapter = s3
  ? {
      async put(key, bytes, contentType) {
        await s3.write(key, bytes, { type: contentType });
      },
      async get(key) {
        const file = s3.file(key);
        if (!(await file.exists())) return null;
        return new Uint8Array(await file.arrayBuffer());
      },
      async delete(key) {
        await s3.delete(key);
      },
    }
  : {
      async put(key, bytes, contentType) {
        void contentType;
        const abs = join(storageDir, key);
        mkdirSync(dirname(abs), { recursive: true });
        await Bun.write(abs, bytes);
      },
      async get(key) {
        const file = Bun.file(join(storageDir, key));
        if (!(await file.exists())) return null;
        return new Uint8Array(await file.arrayBuffer());
      },
      async delete(key) {
        const file = Bun.file(join(storageDir, key));
        if (await file.exists()) {
          await file.delete();
        }
      },
    };
