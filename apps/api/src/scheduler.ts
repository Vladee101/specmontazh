// Команда планировщика: node dist/scheduler.js. Запускается таймером systemd в 00:10 МСК.
// Журнал — stdout/stderr (journald). Код выхода 1, если хотя бы один регламент упал.
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { purgeExpiredSessions } from './http/auth.js';
import { dateIn } from './lib/dates.js';
import { runScheduler } from './services/generation.js';

const config = loadConfig();
const db = createDb(config.databaseUrl, 2);
const log = {
  info: (obj: object, msg: string) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
  error: (obj: object, msg: string) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
};

let failed = false;
try {
  const today = dateIn(config.timeZone, new Date());
  const summary = await runScheduler(db, today, config.horizonDays, log);
  const purged = await purgeExpiredSessions(db, config.sessionIdleMs);
  log.info(
    { today, regulations: summary.regulations, created: summary.created.length, failed: summary.failed.length, sessions_purged: purged },
    'планировщик завершён',
  );
  failed = summary.failed.length > 0;
} catch (err) {
  log.error({ err: err instanceof Error ? err.message : String(err) }, 'планировщик упал');
  failed = true;
} finally {
  await db.destroy();
}
process.exitCode = failed ? 1 : 0;
