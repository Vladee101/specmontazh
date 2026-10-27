import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

// bigint (идентификаторы, count) — в number: значения далеки от 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));
// date — как есть, строкой YYYY-MM-DD: без сдвигов часового пояса.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export type Db = Kysely<Database>;
export type Trx = Transaction<Database>;

export function createDb(connectionString: string, maxConnections = 10): Db {
  const pool = new pg.Pool({ connectionString, max: maxConnections });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
