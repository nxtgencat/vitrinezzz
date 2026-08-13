import { readFileSync } from "node:fs";
import { join } from "node:path";

const log = (await import("../lib/logger")).logger.child({ module: "verify-deps" });
const failures: string[] = [];

const SCAN_DIRS = ["lib", "db", "services", "routes", "scripts", "test"];
const SCAN_ROOT_FILES = ["index.ts", "app.ts"];

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

const files: string[] = [];
for (const dir of SCAN_DIRS) {
  for (const file of new Bun.Glob(`${dir}/**/*.ts`).scanSync({ cwd: process.cwd(), absolute: true })) {
    if (file === join(import.meta.dir, "verify-deps.ts")) continue;
    files.push(file);
  }
}
for (const file of SCAN_ROOT_FILES) {
  files.push(join(process.cwd(), file));
}

const IMPORT_RE = /\b(?:from|import)\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function packageName(specifier: string): string | null {
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) return null;
  if (specifier === "bun" || specifier.startsWith("bun:") || specifier.startsWith("node:")) return null;
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) return segments.slice(0, 2).join("/");
  return segments[0]!;
}

const imported = new Set<string>();
for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const match of content.matchAll(IMPORT_RE)) {
    const specifier = (match[1] ?? match[2])!;
    const name = packageName(specifier);
    if (!name) continue;
    imported.add(name);
    if (!(name in declared)) {
      failures.push(`${file}: import "${specifier}" does not resolve to a declared dependency`);
    }
  }
}

const TOOLING_ALLOWLIST = ["typescript", "@types/bun", "drizzle-kit"];
const DEFERRED_IMPORT_ALLOWLIST: string[] = [];
for (const name of Object.keys(declared)) {
  if (TOOLING_ALLOWLIST.includes(name) || DEFERRED_IMPORT_ALLOWLIST.includes(name)) continue;
  if (!imported.has(name)) {
    failures.push(`dependency "${name}" is declared but never imported (orphan)`);
  }
}

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0] }, "verify-deps FAILED");
  process.exit(1);
}
log.info("verify-deps PASS");
