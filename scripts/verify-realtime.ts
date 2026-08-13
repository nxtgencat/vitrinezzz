import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const log = (await import("../lib/logger")).logger.child({ module: "verify-realtime" });
const failures: string[] = [];

/**
 * Backstop for `architecture.md` §4.8 / `audit.md` §2: a `publish` call inside
 * a `withTx` or `withIdempotency` body is already a compile error (the callbacks
 * are non-async and a publish must never run pre-commit) — this greps for the
 * pattern anyway, so a refactor that somehow routes a publish into a
 * transaction body fails `ci` even if the compiler is misled. Production
 * runtime code only (lib/ routes/ services/ index.ts app.ts); test and script
 * files are exempt by the same logic that exempts scenario setups.
 */
const SCAN_FILES = [
  "lib",
  "routes",
  "services",
].flatMap((dir) => readdirSync(join(process.cwd(), dir)).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f)));
SCAN_FILES.push("index.ts", "app.ts");

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Finds a call's argument window: from `name(` to its matching close paren. */
function callWindows(content: string, name: string, excludeDefinition: RegExp): { start: number; end: number }[] {
  const windows: { start: number; end: number }[] = [];
  const re = new RegExp(`\\b${name}\\(`, "g");
  for (const match of content.matchAll(re)) {
    const lineStart = content.lastIndexOf("\n", match.index) + 1;
    const line = content.slice(lineStart, match.index);
    if (excludeDefinition.test(line)) continue;
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < content.length; i++) {
      const ch = content[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    windows.push({ start: match.index, end: i });
  }
  return windows;
}

const WITH_TX_DEF = /^\s*(export\s+)?(async\s+)?function\s+withTx\b/;
const WITH_IDEM_DEF = /^\s*export\s+async\s+function\s+withIdempotency\b/;

for (const rel of SCAN_FILES) {
  let content: string;
  try {
    content = stripComments(readFileSync(join(process.cwd(), rel), "utf8"));
  } catch {
    failures.push(`${rel}: unreadable`);
    continue;
  }
  const windows = [
    ...callWindows(content, "withTx", WITH_TX_DEF),
    ...callWindows(content, "withIdempotency", WITH_IDEM_DEF),
  ];
  for (const win of windows) {
    const inside = content.slice(win.start, win.end);
    for (const match of inside.matchAll(/\bpublish\(/g)) {
      const lineNo = content.slice(0, win.start + match.index).split("\n").length;
      failures.push(`${rel}:${lineNo}: publish call inside a withTx/withIdempotency body`);
    }
  }
}

/**
 * Every `‡`-marked route in `api.md` must have a matching `publish` call site
 * in the route file that registers it (`audit.md` §2): a route shipping
 * without its realtime wiring is a dead topic.
 */
const API_MD = join(process.cwd(), ".agents", "api.md");
const markedRoutes = [...readFileSync(API_MD, "utf8").matchAll(/^\| (GET|POST|PUT|DELETE) \| `([^`]+)` ‡ \|/gm)].map((m) => m[2]!);

const routeFiles = readdirSync(join(process.cwd(), "routes"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => join("routes", f));

for (const path of markedRoutes) {
  const registered = path.replace(/^\/api/, "");
  const file = routeFiles.find((f) => stripComments(readFileSync(join(process.cwd(), f), "utf8")).includes(registered));
  if (!file) {
    failures.push(`${path}: no route file registers it`);
    continue;
  }
  const content = stripComments(readFileSync(join(process.cwd(), file), "utf8"));
  if (!content.includes("publish(")) {
    failures.push(`${path}: ${file} never calls publish`);
  }
}

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0], all: failures }, "verify-realtime FAILED");
  process.exit(1);
}
log.info({ routes: markedRoutes.length }, "verify-realtime PASS");
