import { randomUUIDv7 } from "bun";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { media } from "../db/schema/media";
import type { Tx } from "../lib/db";
import { writeAuditEvent } from "./audit";
import { requireCapability } from "./rbac";
import type { StaffActor } from "./rbac";

type MediaRow = typeof media.$inferSelect;

export const MEDIA_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type MediaMimeType = (typeof MEDIA_MIME_TYPES)[number];

export const MEDIA_MAX_BYTES = 8 * 1024 * 1024;

export function isMediaMimeType(value: string): value is MediaMimeType {
  return (MEDIA_MIME_TYPES as readonly string[]).includes(value);
}

export function mimeExt(mime: MediaMimeType): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
  }
}

/**
 * Generates the WebP thumbnail (`architecture.md` §4.10) with the resolved
 * `Bun.Image` API (`architecture.md` §6): resize to max width 400 preserving
 * aspect ratio, never upscaling, encode WebP quality 80. A decode failure on
 * corrupt-but-MIME-valid bytes is a client bug → 400, not a 500.
 */
export async function makeThumbnail(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    return await new Bun.Image(bytes)
      .resize(400, undefined, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .bytes();
  } catch (err) {
    throw new HTTPException(400, { message: "image decode failed" });
  }
}

export type UploadMediaInput = {
  ownerType: "product" | "variant";
  ownerId: string;
  path: string;
  thumbPath: string;
  mimeType: MediaMimeType;
  sizeBytes: number;
  altText?: string | null;
};

/**
 * Inserts the `media` row and its `audit_events` row in one transaction
 * (`architecture.md` §4.10). The original + thumbnail bytes are written to
 * storage by the route before this runs (async file I/O cannot live inside a
 * transaction, T1); the route cleans up on replay/rollback. Delete is a hard
 * delete (not a document, not trigger-protected) but still writes an
 * `audit_events` row (`architecture.md` §4.7).
 */
export function uploadMedia(tx: Tx, actor: StaffActor, input: UploadMediaInput): MediaRow {
  requireCapability(actor, "canManageCatalog");
  const row: MediaRow = {
    id: randomUUIDv7(),
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    path: input.path,
    thumbPath: input.thumbPath,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    altText: input.altText ?? null,
    createdAt: Date.now(),
  };
  tx.insert(media).values(row).run();
  writeAuditEvent(tx, {
    entityType: "media",
    entityId: row.id,
    action: "created",
    actorId: actor.userId,
    actorType: "staff",
    before: null,
    after: { ...row },
  });
  return row;
}

export function deleteMedia(tx: Tx, actor: StaffActor, mediaId: string): { id: string; deleted: boolean } {
  requireCapability(actor, "canManageCatalog");
  const existing = tx.select().from(media).where(eq(media.id, mediaId)).get();
  if (!existing) throw new HTTPException(404, { message: "not_found" });
  const before = { ...existing };
  tx.delete(media).where(eq(media.id, mediaId)).run();
  writeAuditEvent(tx, {
    entityType: "media",
    entityId: mediaId,
    action: "deleted",
    actorId: actor.userId,
    actorType: "staff",
    before,
    after: { id: mediaId },
  });
  return { id: mediaId, deleted: true };
}
