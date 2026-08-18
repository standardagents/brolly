import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type SqliteValue = string | number | bigint | Uint8Array | null;

class TestPreparedStatement {
  private values: SqliteValue[] = [];

  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.values = values.map(value => value === undefined ? null : value as SqliteValue);
    return this;
  }

  async run(): Promise<D1Result<unknown>> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const results = this.database.prepare(this.sql).all(...this.values) as T[];
    return { success: true, results, meta: { rows_read: results.length } };
  }
}

export interface TestD1 {
  db: D1Database;
  close(): void;
}

export function createTestD1(): TestD1 {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
  for (const name of readdirSync(migrationDirectory).filter(file => file.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(migrationDirectory, name), "utf8"));
  }

  const db = {
    prepare(sql: string): D1PreparedStatement {
      return new TestPreparedStatement(database, sql) as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
      database.exec("BEGIN");
      try {
        const results: D1Result<unknown>[] = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, close: () => database.close() };
}
