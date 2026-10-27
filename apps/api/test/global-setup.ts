// Пересоздаёт тестовую БД и применяет миграции один раз на весь прогон.
// Адрес — TEST_DATABASE_URL; база с этим именем удаляется, поэтому имя обязано
// заканчиваться на _test: рабочую базу тест не тронет.
import pg from 'pg';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrator.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres@localhost:54329/sm_to_test';

export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  if (!dbName.endsWith('_test')) throw new Error(`TEST_DATABASE_URL должен указывать на базу *_test, получено: ${dbName}`);

  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const db = createDb(TEST_DATABASE_URL, 1);
  await migrate(db);
  await db.destroy();
  process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;
}
