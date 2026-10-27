// Команда: node dist/migrate.js — применяет новые SQL-миграции.
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrator.js';

const config = loadConfig();
const db = createDb(config.databaseUrl, 1);
try {
  const applied = await migrate(db, config.migrationsDir);
  console.log(applied.length ? `применены миграции: ${applied.join(', ')}` : 'новых миграций нет');
} finally {
  await db.destroy();
}
