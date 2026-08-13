import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

const dbPath = process.env.DATABASE_PATH ?? "./data/vitrine.sqlite";

mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.run("PRAGMA journal_mode = WAL;");

export const db = drizzle(sqlite);

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function withTx<T>(fn: (tx: Tx) => T): Promise<T> {
  return db.transaction((tx) => fn(tx), { behavior: "immediate" });
}
