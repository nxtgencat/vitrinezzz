import { readFileSync } from "node:fs";
import { join } from "node:path";

const log = (await import("../lib/logger")).logger.child({ module: "verify-hygiene" });
const failures: string[] = [];

const SCAN_DIRS = ["lib", "db", "services", "routes", "scripts", "test"];
const SCAN_ROOT_FILES = ["index.ts", "app.ts", "drizzle.config.ts"];

function scanFiles(): { path: string; lines: string[] }[] {
  const files: { path: string; lines: string[] }[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of new Bun.Glob(`${dir}/**/*.ts`).scanSync({ cwd: process.cwd(), absolute: true })) {
      if (file === join(import.meta.dir, "verify-hygiene.ts")) continue;
      files.push({ path: file, lines: readFileSync(file, "utf8").split("\n") });
    }
  }
  for (const file of SCAN_ROOT_FILES) {
    const abs = join(process.cwd(), file);
    files.push({ path: abs, lines: readFileSync(abs, "utf8").split("\n") });
  }
  return files;
}

const files = scanFiles();

for (const { path, lines } of files) {
  lines.forEach((line, i) => {
    if (/\bconsole\.\w+\(/.test(line)) {
      failures.push(`${path}:${i + 1}: console.* is banned (zero exemptions)`);
    }
    if (/\b(as|:)\s+any\b|\bany\[\]|<any>/.test(line)) {
      failures.push(`${path}:${i + 1}: \`any\` is banned (zero exemptions)`);
    }
  });
}

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const BANNED_PACKAGES = [
  "redis",
  "ioredis",
  "bullmq",
  "puppeteer",
  "playwright",
  "pdf-lib",
  "sharp",
  "bcryptjs",
  "argon2",
  "node-cron",
  "multer",
  "uuid",
  "dotenv",
  "ws",
  "archiver",
  "tar",
  "kysely",
  "@hono/node-server",
];
const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
for (const banned of BANNED_PACKAGES) {
  if (banned in declared) {
    failures.push(`package.json: banned dependency "${banned}" is declared`);
  }
}

const tsconfig = JSON.parse(
  readFileSync(join(process.cwd(), "tsconfig.json"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^"\\])\/\/.*$/gm, "$1"),
) as {
  compilerOptions?: Record<string, unknown>;
};
const required = {
  strict: true,
  noUncheckedIndexedAccess: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  verbatimModuleSyntax: true,
  esModuleInterop: true,
};
for (const [key, expected] of Object.entries(required)) {
  const actual = tsconfig.compilerOptions?.[key];
  if (actual !== expected) {
    failures.push(`tsconfig.json: compilerOptions.${key} must be ${String(expected)}, got ${String(actual)}`);
  }
}
const types = tsconfig.compilerOptions?.types;
if (!Array.isArray(types) || !types.includes("bun")) {
  failures.push('tsconfig.json: compilerOptions.types must include "bun"');
}

const typecheck = Bun.spawnSync(["bun", "run", "typecheck"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
if (typecheck.exitCode !== 0) {
  failures.push(`bun run typecheck failed under strict: true (exit ${String(typecheck.exitCode)})`);
  failures.push(typecheck.stdout.toString().slice(0, 2000));
}

const CLIENT_ORIGINABLE_MONEY_KEYS = [
  "unitPricePaise",
  "amountPaise",
  "unitCostPaise",
  "costPricePaise",
  "sellingPricePaise",
  "mrpPaise",
];
for (const { path, lines } of files) {
  const content = lines.join("\n");
  if (!/z\.object|zValidator/.test(content)) continue;
  lines.forEach((line, i) => {
    for (const match of line.matchAll(/\b([a-zA-Z]+Paise):/g)) {
      const key = match[1]!;
      if (!CLIENT_ORIGINABLE_MONEY_KEYS.includes(key)) {
        failures.push(
          `${path}:${i + 1}: route schema field "${key}" is not in the closed client-originable list (architecture.md §4.4)`,
        );
      }
    }
  });
}

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0] }, "verify-hygiene FAILED");
  process.exit(1);
}
log.info("verify-hygiene PASS");
