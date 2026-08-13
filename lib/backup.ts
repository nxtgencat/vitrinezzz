import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger";

const DEFAULT_BACKUP_DIR = "./data/backups";
const BACKUP_RETENTION_DAYS = 30;

function backupDir(): string {
  return process.env.BACKUP_DIR ?? DEFAULT_BACKUP_DIR;
}

async function copyIfExists(src: string, dest: string): Promise<void> {
  if (await Bun.file(src).exists()) {
    await Bun.write(dest, Bun.file(src));
  }
}

/**
 * Deletes backup files older than `n` × `unit` from the backup dir, keyed off
 * the file's mtime (a copy just written has mtime = now). Never throws for an
 * individual file — a stale file is not worth failing the run for.
 */
export function pruneBackupsOlderThan(n: number, unit: "days" | "hours"): number {
  const cutoff = Date.now() - (unit === "days" ? n * 86400000 : n * 3600000);
  let pruned = 0;
  const dir = backupDir();
  for (const file of new Bun.Glob("vitrine-*.sqlite*").scanSync({ cwd: dir, absolute: true })) {
    try {
      if (Bun.file(file).lastModified < cutoff) {
        rmSync(file, { force: true });
        pruned += 1;
      }
    } catch (err) {
      logger.warn({ err, file }, "backup prune skipped");
    }
  }
  if (pruned > 0) logger.info({ pruned }, "old backups pruned");
  return pruned;
}

/**
 * Copies the live database plus its WAL/SHM companions into the backup dir as
 * `vitrine-<stamp>.sqlite[(-wal|-shm)]` — the three files together are a
 * consistent snapshot at copy time (`architecture.md` §4.18) — then prunes
 * backups older than 30 days. Never throws past its own catch: a failed backup
 * must not affect the running process. Returns the main backup path on
 * success, `null` on failure.
 */
export async function runNightlyBackup(): Promise<string | null> {
  try {
    const src = process.env.DATABASE_PATH ?? "./data/vitrine.sqlite";
    const dir = backupDir();
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const main = join(dir, `vitrine-${stamp}.sqlite`);
    await copyIfExists(src, main);
    await copyIfExists(`${src}-wal`, `${main}-wal`);
    await copyIfExists(`${src}-shm`, `${main}-shm`);
    pruneBackupsOlderThan(BACKUP_RETENTION_DAYS, "days");
    logger.info({ backup: main }, "nightly backup complete");
    return main;
  } catch (err) {
    logger.error({ err }, "nightly backup failed");
    return null;
  }
}