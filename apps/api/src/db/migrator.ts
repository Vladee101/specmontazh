// Миграции — обычные SQL-файлы db/migrations/NNNN_name.sql, применяются по порядку имён.
// Каждый файл — в своей транзакции; применённые записываются в schema_migrations.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import type { Db } from './index.js';

// apps/api/{src,dist}/db → корень репозитория
export const DEFAULT_MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations');
const LOCK_KEY = 732_101; // advisory lock: два одновременных запуска не применят файл дважды

export async function migrate(db: Db, dir = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  await db.connection().execute(async (conn) => {
    await sql`SELECT pg_advisory_lock(${LOCK_KEY})`.execute(conn);
    try {
      await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`.execute(conn);
      const done = new Set((await conn.selectFrom('schema_migrations').select('name').execute()).map((r) => r.name));
      for (const file of files) {
        if (done.has(file)) continue;
        const text = await readFile(join(dir, file), 'utf8');
        await conn.transaction().execute(async (trx) => {
          await sql.raw(text).execute(trx);
          await trx.insertInto('schema_migrations').values({ name: file }).execute();
        });
        applied.push(file);
      }
    } finally {
      await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`.execute(conn);
    }
  });
  return applied;
}
