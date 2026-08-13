import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUIDv7 } from "bun";

process.env.NODE_ENV = "test";
const tmpPath = join("data", `verify-routes-${randomUUIDv7()}.sqlite`);
process.env.DATABASE_PATH = tmpPath;
process.env.AUTH_SECRET = "verify-routes-secret";

const { logger } = await import("../lib/logger");
const log = logger.child({ module: "verify-routes" });
const failures: string[] = [];

const { app } = await import("../app");

/**
 * Route-coverage verifier (`audit.md` §2 row 4): every route row in `api.md`
 * §1–§10 must be mounted on `app.routes`, and every mounted route must appear
 * in a row — both directions.
 *
 * api.md row syntax (`api.md` §0):
 * - Method cells may combine methods with `/` (`GET/POST`); `WS` maps to the
 *   GET upgrade.
 * - A path cell may carry multiple comma-separated paths.
 * - `[/:param]` expands by method: GET → base + `/:param` (list + detail);
 *   POST → base only (create); DELETE → `/:param` only (delete one).
 * - A trailing `‡` marks realtime wiring (`verify-realtime`'s concern) and is
 *   ignored here.
 * - `/api/auth/*` is mounted as one better-auth wildcard pair; the §1 rows
 *   collapse onto it.
 */
const METHOD_CELL = /^(GET|POST|PUT|DELETE|WS)(\/(GET|POST|PUT|DELETE|WS))*$/;

function docRouteSet(apiMdPath: string): Set<string> {
  const rows: string[] = [];
  for (const line of readFileSync(apiMdPath, "utf8").split("\n")) {
    const cells = line.split("|").map((s) => s.trim());
    if (cells.length < 4) continue;
    const methodCell = cells[1]!;
    if (!METHOD_CELL.test(methodCell)) continue;
    let pathCell = cells[2]!.replaceAll("`", "").trim().replace(/‡\s*$/, "").trim();
    if (!pathCell.startsWith("/")) continue;
    const paths = pathCell
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const methods = methodCell.split("/");
    for (const p of paths) {
      const bracket = p.match(/\[(\/:[a-zA-Z]+)\]$/);
      const base = p.replace(/\[\/:[a-zA-Z]+\]$/, "");
      const forms = bracket ? [base, base + bracket[1]!] : [p];
      for (const path of forms) {
        for (const rawMethod of methods) {
          const method = rawMethod === "WS" ? "GET" : rawMethod;
          if (bracket) {
            const isParamForm = path === base + bracket[1]!;
            if (method === "POST" && isParamForm) continue;
            if (method === "DELETE" && !isParamForm) continue;
          }
          const finalPath = path.startsWith("/api/auth/") ? "/api/auth/*" : path;
          rows.push(`${method} ${finalPath}`);
        }
      }
    }
  }
  return new Set(rows);
}

const apiMdPath = join(process.cwd(), ".agents", "api.md");
const docRoutes = docRouteSet(apiMdPath);
const mountedRoutes = new Set(app.routes.map((r) => `${r.method} ${r.path}`));

const documentedButUnmounted = [...docRoutes].filter((r) => !mountedRoutes.has(r)).sort();
const mountedButUndocumented = [...mountedRoutes].filter((r) => !docRoutes.has(r)).sort();

if (documentedButUnmounted.length > 0) {
  failures.push(`documented but not mounted (${documentedButUnmounted.length}): ${documentedButUnmounted.join(", ")}`);
}
if (mountedButUndocumented.length > 0) {
  failures.push(`mounted but not documented (${mountedButUndocumented.length}): ${mountedButUndocumented.join(", ")}`);
}

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0] }, "verify-routes FAILED");
  process.exit(1);
}
log.info({ docRoutes: docRoutes.size, mountedRoutes: mountedRoutes.size }, "verify-routes PASS");