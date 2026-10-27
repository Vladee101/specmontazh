import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { Role } from '../db/types.js';
import { dateIn } from '../lib/dates.js';

export interface SessionUser {
  id: number;
  login: string;
  full_name: string;
  role: Role;
}

export interface AppContext {
  db: Db;
  config: Config;
  /** Текущее время; в тестах подменяется. */
  now: () => Date;
}

export function today(ctx: AppContext): string {
  return dateIn(ctx.config.timeZone, ctx.now());
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    user: SessionUser | null;
    csrfToken: string | null;
    sessionHash: string | null;
  }
  interface FastifyContextConfig {
    /** Маршрут доступен без входа. */
    public?: boolean;
    /** Роли, которым разрешён маршрут; пусто — любая роль после входа. */
    roles?: Role[];
  }
}
