// UC 01: вход, выход, текущий пользователь.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  clearSessionCookie,
  createSession,
  currentUser,
  SESSION_COOKIE,
  hashToken,
  setSessionCookie,
} from '../http/auth.js';
import { AppError, parse } from '../http/errors.js';
import { DUMMY_HASH, verifyPassword } from '../lib/password.js';

const LoginBody = z.object({
  login: z.string().trim().min(1, 'Введите логин').max(150),
  password: z.string().min(1, 'Введите пароль').max(128),
});

export async function authRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  app.post(
    '/auth/login',
    { config: { public: true, rateLimit: { max: app.ctx.config.loginRateLimit, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parse(LoginBody, req.body);
      const user = await db
        .selectFrom('users')
        .select(['id', 'login', 'full_name', 'role', 'is_active', 'password_hash'])
        .where((eb) => eb(eb.fn('lower', ['login']), '=', body.login.toLowerCase()))
        .executeTakeFirst();

      // Пароль сверяется всегда, даже без пользователя: время ответа не выдаёт существование логина.
      const ok = await verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH);
      if (!user || !ok) throw new AppError(401, 'invalid_credentials', 'Неверный логин или пароль');
      if (!user.is_active) throw new AppError(403, 'user_blocked', 'Учётная запись заблокирована. Обратитесь к администратору.');

      const { token, csrfToken } = await createSession(db, user.id);
      setSessionCookie(app.ctx, reply, token);
      return {
        user: { id: user.id, login: user.login, full_name: user.full_name, role: user.role },
        csrf_token: csrfToken,
      };
    },
  );

  app.post('/auth/logout', { config: { public: true } }, async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await db.deleteFrom('sessions').where('token_hash', '=', hashToken(token)).execute();
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => ({ user: currentUser(req), csrf_token: req.csrfToken }));
}
