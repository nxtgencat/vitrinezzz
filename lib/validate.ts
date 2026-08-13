import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

/**
 * Route-boundary validation (`architecture.md` §2/§6). `zValidator` does not
 * throw by default — the hook must throw explicitly, or invalid input silently
 * 200s. `cause` carries the Zod error so `handleError` maps its `issues` into
 * the `details` array of the VALIDATION envelope.
 */
function hook(result: { success: boolean; error?: unknown }): void {
  if (!result.success) throw new HTTPException(400, { cause: result.error });
}

export function jsonValidator<T extends z.ZodType>(schema: T) {
  return zValidator("json", schema, (result) => hook(result));
}

export function queryValidator<T extends z.ZodType>(schema: T) {
  return zValidator("query", schema, (result) => hook(result));
}

export function paramValidator<T extends z.ZodType>(schema: T) {
  return zValidator("param", schema, (result) => hook(result));
}