// Сессии и проверка доступа. Токен сессии — случайная строка в cookie HttpOnly;
// в БД хранится только его SHA-256. CSRF: токен сессии в заголовке X-CSRF-Token
// для изменяющих запросов плюс проверка Origin.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import type { AppContext, SessionUser } from './context.js';
import { AppError, forbidden, unauthorized } from './errors.js';

export const SESSION_COOKIE = 'sm_sid';
export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// last_seen_at обновляется не чаще раза в минуту: меньше записей в БД
const TOUCH_INTERVAL_MS = 60_000;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(db: Db, userId: number): Promise<{ token: string; csrfToken: string }> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  await db.insertInto('sessions').values({ token_hash: hashToken(token), user_id: userId, csrf_token: csrfToken }).execute();
  return { token, csrfToken };
}

export async function deleteUserSessions(db: Db, userId: number): Promise<void> {
  await db.deleteFrom('sessions').where('user_id', '=', userId).execute();
}

export function setSessionCookie(ctx: AppContext, reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: ctx.config.env === 'production',
    sameSite: 'lax',
    path: '/',
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

function checkOrigin(ctx: AppContext, req: FastifyRequest): void {
  const origin = req.headers.origin;
  if (origin && ctx.config.appOrigin && origin !== ctx.config.appOrigin) {
    throw forbidden('Запрос с чужого сайта отклонён');
  }
}

async function loadSession(ctx: AppContext, req: FastifyRequest): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return;
  const tokenHash = hashToken(token);
  const row = await ctx.db
    .selectFrom('sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .select(['s.csrf_token', 's.last_seen_at', 'u.id', 'u.login', 'u.full_name', 'u.role', 'u.is_active'])
    .where('s.token_hash', '=', tokenHash)
    .executeTakeFirst();
  if (!row) return;

  const now = ctx.now();
  const idle = now.getTime() - row.last_seen_at.getTime();
  if (!row.is_active || idle > ctx.config.sessionIdleMs) {
    await ctx.db.deleteFrom('sessions').where('token_hash', '=', tokenHash).execute();
    return;
  }
  if (idle > TOUCH_INTERVAL_MS) {
    await ctx.db.updateTable('sessions').set({ last_seen_at: now }).where('token_hash', '=', tokenHash).execute();
  }
  const user: SessionUser = { id: row.id, login: row.login, full_name: row.full_name, role: row.role };
  req.user = user;
  req.csrfToken = row.csrf_token;
  req.sessionHash = tokenHash;
}

export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('user', null);
  app.decorateRequest('csrfToken', null);
  app.decorateRequest('sessionHash', null);

  app.addHook('preHandler', async (req) => {
    const cfg = req.routeOptions.config;
    const mutating = !SAFE_METHODS.has(req.method);
    if (mutating) checkOrigin(app.ctx, req);
    if (cfg.public) return;

    await loadSession(app.ctx, req);
    if (!req.user) throw unauthorized();
    if (mutating && req.headers[CSRF_HEADER] !== req.csrfToken) {
      throw new AppError(403, 'csrf_failed', 'Неверный CSRF-токен. Обновите страницу.');
    }
    if (cfg.roles && cfg.roles.length > 0 && !cfg.roles.includes(req.user.role)) throw forbidden();
  });
}

/** Пользователь запроса; маршрут уже прошёл проверку входа. */
export function currentUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** Удаляет сессии, простой которых превысил лимит (вызывается планировщиком). */
export async function purgeExpiredSessions(db: Db, idleMs: number): Promise<number> {
  const res = await db
    .deleteFrom('sessions')
    .where('last_seen_at', '<', sql<Date>`now() - make_interval(secs => ${idleMs / 1000})`)
    .executeTakeFirst();
  return Number(res.numDeletedRows);
}
