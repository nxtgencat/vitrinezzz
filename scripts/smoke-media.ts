import { randomUUIDv7 } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";

process.env.NODE_ENV = "test";
const tmpPath = join("data", `smoke-media-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.STORAGE_DIR = join("data", `smoke-media-storage-${randomUUIDv7()}`);
process.env.AUTH_SECRET = "smoke-media-secret";
process.env.SUPERUSER_EMAIL = "admin@media.test";
process.env.SUPERUSER_PASSWORD = "admin-pass-123";

mkdirSync(dirname(tmpPath), { recursive: true });

const { logger } = await import("../lib/logger");
const log = logger.child({ module: "smoke-media" });
const failures: string[] = [];

const { db } = await import("../lib/db");
const { applyMigrations } = await import("../lib/migrate");
const { bootstrapAdmin } = await import("../lib/auth");
const { app } = await import("../app");
const { media } = await import("../db/schema/media");
const { auditEvents } = await import("../db/schema/facts");

applyMigrations(db);
await bootstrapAdmin();

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_1x1 = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

function assert(cond: boolean, msg: string): void {
  if (!cond) failures.push(msg);
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => c.length > 0)
    .join("; ");
}

async function signIn(): Promise<string> {
  const res = await app.fetch(
    new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@media.test", password: "admin-pass-123" }),
    }),
  );
  assert(res.status === 200, `sign-in status ${res.status}`);
  return cookiesOf(res);
}

async function jsonApi(
  cookies: string,
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    cookie: cookies,
    "content-type": "application/json",
  };
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    }),
  );
}

async function uploadApi(
  cookies: string,
  path: string,
  bytes: Uint8Array,
  type: string,
  init: { fileName?: string; altText?: string; idempotencyKey?: string } = {},
): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([bytes], init.fileName ?? "upload.png", { type }));
  if (init.altText !== undefined) form.append("altText", init.altText);
  const headers: Record<string, string> = { cookie: cookies };
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers,
      body: form,
    }),
  );
}

type Envelope = {
  error?: { code?: string; message?: string; reason?: string; details?: unknown[] };
  data?: unknown[];
  [key: string]: unknown;
};

async function body(res: Response): Promise<Envelope> {
  return (await res.json()) as Envelope;
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

async function scenario(): Promise<void> {
  const cookies = await signIn();

  const productRes = await jsonApi(cookies, "/api/products", {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {
      name: "Media Soda",
      hsnCode: "22021010",
      gstRatePct: 12,
      baseVariant: { name: "Media Soda 500ml", sku: "MS-500", costPricePaise: 2000, sellingPricePaise: 2400 },
    },
  });
  assert(productRes.status === 200, `create product: ${productRes.status}`);
  const product = (await body(productRes)) as { product: { id: string }; baseVariant: { id: string } };
  const productId = product.product.id;
  const variantId = product.baseVariant.id;

  const noKey = await uploadApi(cookies, `/api/products/${productId}/media`, PNG_1x1, "image/png", {
    fileName: "photo.png",
  });
  assert(noKey.status === 400, `upload without idempotency key must be 400, got ${noKey.status}`);
  const noKeyErr = (await body(noKey)) as { error?: { reason?: string } };
  assert(noKeyErr.error?.reason === "idempotency_key_required", "missing-key reason mismatch");

  const uploadKey = randomUUIDv7();
  const upload = await uploadApi(cookies, `/api/products/${productId}/media`, PNG_1x1, "image/png", {
    fileName: "photo.png",
    altText: "front label",
    idempotencyKey: uploadKey,
  });
  assert(upload.status === 200, `media upload: expected 200, got ${upload.status}`);
  const mediaRow = (await body(upload)) as {
    id: string;
    ownerType: string;
    ownerId: string;
    path: string;
    thumbPath: string;
    mimeType: string;
    sizeBytes: number;
    altText: string;
  };
  assert(mediaRow.mimeType === "image/png", "upload mimeType mismatch");
  assert(mediaRow.sizeBytes === PNG_1x1.length, "upload sizeBytes mismatch");
  assert(mediaRow.altText === "front label", "altText not stored");
  assert(mediaRow.path.endsWith(".png"), "original path must keep the source extension");
  assert(mediaRow.thumbPath.endsWith(".webp"), "thumbnail path must be webp");

  const thumbBytes = new Uint8Array(await Bun.file(join(process.env.STORAGE_DIR!, mediaRow.thumbPath)).arrayBuffer());
  assert(isWebp(thumbBytes), "thumbnail file must be a WebP");
  const originalBytes = new Uint8Array(await Bun.file(join(process.env.STORAGE_DIR!, mediaRow.path)).arrayBuffer());
  assert(originalBytes.length === PNG_1x1.length, "stored original must byte-match the upload");

  const auditCreated = db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(eq(auditEvents.entityType, "media"))
    .all().length;
  assert(auditCreated === 1, `media upload must write exactly 1 audit row, got ${auditCreated}`);

  const replay = await uploadApi(cookies, `/api/products/${productId}/media`, PNG_1x1, "image/png", {
    fileName: "photo.png",
    altText: "front label",
    idempotencyKey: uploadKey,
  });
  assert(replay.status === 200, `replay upload: expected 200, got ${replay.status}`);
  assert(replay.headers.get("idempotency-replayed") === "true", "same-key upload must replay");
  const mediaRowsAfterReplay = db.select().from(media).all().length;
  assert(mediaRowsAfterReplay === 1, "replay must not create a second media row");

  const different = await new Bun.Image(PNG_1x1).resize(2, 2).png().bytes();
  const mismatch = await uploadApi(cookies, `/api/products/${productId}/media`, different, "image/png", {
    fileName: "photo.png",
    altText: "front label",
    idempotencyKey: uploadKey,
  });
  assert(mismatch.status === 409, `same key + different bytes must be 409, got ${mismatch.status}`);
  const mismatchErr = (await body(mismatch)) as { error?: { reason?: string } };
  assert(mismatchErr.error?.reason === "idempotency_mismatch", "upload hash mismatch reason");

  const serve = await app.fetch(new Request(`http://localhost/api/media/${mediaRow.id}`));
  assert(serve.status === 200, `serve media: expected 200, got ${serve.status}`);
  assert(serve.headers.get("content-type") === "image/png", "served content-type mismatch");
  const served = new Uint8Array(await serve.arrayBuffer());
  assert(served.length === PNG_1x1.length, "served bytes must match the original");

  const list = await jsonApi("", `/api/products/${productId}/media`);
  assert(list.status === 200, `public media list: expected 200, got ${list.status}`);
  const listBody = (await body(list)) as { data: unknown[] };
  assert(listBody.data?.length === 1, "product media list must contain exactly 1 row");

  const badMime = await uploadApi(cookies, `/api/products/${productId}/media`, new TextEncoder().encode("hello"), "text/plain", {
    fileName: "notes.txt",
    idempotencyKey: randomUUIDv7(),
  });
  assert(badMime.status === 400, `bad mime must be 400, got ${badMime.status}`);

  const oversized = new Uint8Array(9 * 1024 * 1024);
  const tooBig = await uploadApi(cookies, `/api/products/${productId}/media`, oversized, "image/png", {
    idempotencyKey: randomUUIDv7(),
  });
  assert(tooBig.status === 400, `oversized upload must be 400, got ${tooBig.status}`);

  const variantUpload = await uploadApi(cookies, `/api/variants/${variantId}/media`, PNG_1x1, "image/png", {
    idempotencyKey: randomUUIDv7(),
  });
  assert(variantUpload.status === 200, `variant media upload: expected 200, got ${variantUpload.status}`);
  const variantRow = (await body(variantUpload)) as { id: string; ownerType: string };
  assert(variantRow.ownerType === "variant", "variant upload ownerType mismatch");

  const missingOwner = await uploadApi(cookies, `/api/products/${randomUUIDv7()}/media`, PNG_1x1, "image/png", {
    idempotencyKey: randomUUIDv7(),
  });
  assert(missingOwner.status === 404, `upload to missing owner must be 404, got ${missingOwner.status}`);

  const deleteRes = await jsonApi(cookies, `/api/media/${mediaRow.id}`, {
    method: "DELETE",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(deleteRes.status === 200, `delete media: expected 200, got ${deleteRes.status}`);
  const gone = db.select().from(media).where(eq(media.id, mediaRow.id)).get();
  assert(gone === undefined, "deleted media row must be gone");
  assert(!(await Bun.file(join(process.env.STORAGE_DIR!, mediaRow.path)).exists()), "deleted original file must be gone");
  assert(!(await Bun.file(join(process.env.STORAGE_DIR!, mediaRow.thumbPath)).exists()), "deleted thumbnail file must be gone");
  const auditDeleted = db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, "media"), eq(auditEvents.action, "deleted")))
    .all().length;
  assert(auditDeleted === 1, `media delete must add exactly one 'deleted' audit row, got ${auditDeleted}`);

  const deactivate = await jsonApi(cookies, `/api/products/${productId}/deactivate`, {
    method: "POST",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(deactivate.status === 200, `deactivate product: ${deactivate.status}`);
  const afterDeactivate = await jsonApi("", `/api/variants/${variantId}/media`);
  const afterBody = (await body(afterDeactivate)) as { data: unknown[] };
  assert(afterBody.data?.length === 1, "variant media must survive owner product deactivation (no cascade)");

  const deleteGone = await jsonApi(cookies, `/api/media/${variantRow.id}`, {
    method: "DELETE",
    idempotencyKey: randomUUIDv7(),
    body: {},
  });
  assert(deleteGone.status === 200, `delete variant media: ${deleteGone.status}`);

  const serveGone = await app.fetch(new Request(`http://localhost/api/media/${mediaRow.id}`));
  assert(serveGone.status === 404, `serve deleted media must be 404, got ${serveGone.status}`);
}

try {
  await scenario();
} catch (err) {
  failures.push(`smoke-media scenario threw: ${String(err)}`);
} finally {
  db.$client.close();
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
  rmSync(process.env.STORAGE_DIR!, { recursive: true, force: true });
}

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0], all: failures }, "smoke-media FAILED");
  process.exit(1);
}
log.info("smoke-media PASS");