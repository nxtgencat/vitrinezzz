import { join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

export const migrationsFolder = join(import.meta.dir, "..", "db", "migrations");

export function applyMigrations<TSchema extends Record<string, unknown>>(
  db: BunSQLiteDatabase<TSchema>,
): void {
  migrate(db, { migrationsFolder });
}
