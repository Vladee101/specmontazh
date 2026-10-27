// Команда: node dist/seed.js [--demo] — шаблоны, первый администратор и (по флагу) демо-данные.
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { seedAdmin, seedTemplates } from './db/seed.js';
import { seedDemo } from './db/demo.js';

const config = loadConfig();
const db = createDb(config.databaseUrl, 1);
try {
  const templates = await seedTemplates(db);
  console.log(templates.length ? `созданы шаблоны: ${templates.join(', ')}` : 'шаблоны уже есть');

  const admin = await seedAdmin(db, config.admin);
  console.log(
    admin === 'created'
      ? `создан администратор ${config.admin.login}; удалите ADMIN_PASSWORD из .env`
      : admin === 'exists'
        ? 'администратор уже есть'
        : 'администратор не создан: задайте ADMIN_LOGIN и ADMIN_PASSWORD',
  );

  if (process.argv.includes('--demo')) {
    const password = process.env.DEMO_PASSWORD;
    if (!password || password.length < 8) throw new Error('Для демо-данных задайте DEMO_PASSWORD (не короче 8 символов)');
    console.log(await seedDemo(db, password, config.timeZone));
  }
} finally {
  await db.destroy();
}
