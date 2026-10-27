import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './http/auth.js';
import type { AppContext } from './http/context.js';
import { registerErrorHandler } from './http/errors.js';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { regulationRoutes } from './routes/regulations.js';
import { reportRoutes } from './routes/reports.js';
import { taskRoutes } from './routes/tasks.js';
import { templateRoutes } from './routes/templates.js';
import { userRoutes } from './routes/users.js';

export async function buildApp(ctx: AppContext, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: ctx.config.trustProxy,
    logger:
      opts.logger === false
        ? false
        : {
            level: ctx.config.logLevel,
            // пароли и токены не попадают в журнал
            redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'body.password'],
          },
  });
  app.decorate('ctx', ctx);

  registerErrorHandler(app);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  registerAuth(app);

  app.get('/api/health', { config: { public: true } }, async () => {
    await ctx.db.selectNoFrom((eb) => eb.lit(1).as('ok')).execute();
    return { status: 'ok' };
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(userRoutes);
      await api.register(catalogRoutes);
      await api.register(templateRoutes);
      await api.register(regulationRoutes);
      await api.register(taskRoutes);
      await api.register(reportRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
