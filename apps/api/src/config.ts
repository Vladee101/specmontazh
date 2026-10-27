import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3010),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL не задан'),
  APP_ORIGIN: z.string().optional(),
  TZ: z.string().default('Europe/Moscow'),
  SCHEDULER_HORIZON_DAYS: z.coerce.number().int().min(0).default(5),
  SESSION_IDLE_HOURS: z.coerce.number().positive().default(8),
  TRUST_PROXY: z.string().default('127.0.0.1'),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z.string().default('info'),
  MIGRATIONS_DIR: z.string().optional(),
  ADMIN_LOGIN: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_FULL_NAME: z.string().default('Администратор'),
});

export interface Config {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  databaseUrl: string;
  appOrigin: string | undefined;
  timeZone: string;
  horizonDays: number;
  sessionIdleMs: number;
  trustProxy: string;
  loginRateLimit: number;
  logLevel: string;
  migrationsDir: string | undefined;
  admin: { login?: string; password?: string; fullName: string };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Ошибка конфигурации:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    appOrigin: e.APP_ORIGIN || undefined,
    timeZone: e.TZ,
    horizonDays: e.SCHEDULER_HORIZON_DAYS,
    sessionIdleMs: e.SESSION_IDLE_HOURS * 3600_000,
    trustProxy: e.TRUST_PROXY,
    loginRateLimit: e.LOGIN_RATE_LIMIT,
    logLevel: e.LOG_LEVEL,
    migrationsDir: e.MIGRATIONS_DIR,
    admin: { login: e.ADMIN_LOGIN || undefined, password: e.ADMIN_PASSWORD || undefined, fullName: e.ADMIN_FULL_NAME },
  };
}
