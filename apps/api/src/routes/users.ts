// UC 02–03: пользователи (администратор) и список инженеров (руководитель).
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Trx } from '../db/index.js';
import { assertVersion, requireRow } from '../db/helpers.js';
import type { Role } from '../db/types.js';
import { currentUser } from '../http/auth.js';
import { conflict, parse } from '../http/errors.js';
import { boolQuery, idParam, LIMITS, pageResult, pagination, requiredText, version } from '../http/schemas.js';
import { OPEN_TASK_STATUSES } from '../lib/labels.js';
import { hashPassword } from '../lib/password.js';

const role = z.enum(['admin', 'manager', 'engineer'], { error: 'Выберите роль' });
const password = z.string({ error: 'Введите пароль' }).min(8, 'Пароль не короче 8 символов').max(128, 'Пароль не длиннее 128 символов');
const login = requiredText(LIMITS.login, 'Введите логин').refine((v) => v.length >= 3, 'Логин не короче 3 символов');

const CreateUser = z.object({ login, full_name: requiredText(LIMITS.name, 'Введите ФИО'), role, password });
const UpdateUser = z.object({
  version,
  login: login.optional(),
  full_name: requiredText(LIMITS.name, 'Введите ФИО').optional(),
  role: role.optional(),
});
const PasswordBody = z.object({ version, password });
const ListQuery = pagination.extend({ q: z.string().trim().optional(), role: role.optional(), active: boolQuery });

// Задания, которые инженер не завершил (у «Создано» исполнителя нет).
const ENGINEER_OPEN = OPEN_TASK_STATUSES.filter((s) => s !== 'created');

async function openTasksOf(trx: Trx, userId: number) {
  return trx
    .selectFrom('maintenance_task')
    .select(['id', 'task_number', 'status'])
    .where('assigned_engineer_id', '=', userId)
    .where('status', 'in', ENGINEER_OPEN)
    .orderBy('current_due_date')
    .execute();
}

/** Нельзя оставить систему без активного администратора. Блокирует строки админов до конца транзакции. */
async function assertNotLastAdmin(trx: Trx, userId: number) {
  const admins = await trx.selectFrom('users').select('id').where('role', '=', 'admin').where('is_active', '=', true).forUpdate().execute();
  if (admins.length <= 1 && admins.some((a) => a.id === userId)) {
    throw conflict('last_admin', 'Нельзя убрать или заблокировать последнего активного администратора');
  }
}

const publicColumns = ['id', 'login', 'full_name', 'role', 'is_active', 'created_at', 'version'] as const;

export async function userRoutes(app: FastifyInstance) {
  const { db } = app.ctx;
  const admin = { config: { roles: ['admin'] as Role[] } };

  app.get('/users', admin, async (req) => {
    const q = parse(ListQuery, req.query);
    let query = db.selectFrom('users as u');
    if (q.q) {
      const like = `%${q.q}%`;
      query = query.where((eb) => eb.or([eb('u.full_name', 'ilike', like), eb('u.login', 'ilike', like)]));
    }
    if (q.role) query = query.where('u.role', '=', q.role);
    if (q.active !== undefined) query = query.where('u.is_active', '=', q.active);

    const { total } = await query.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow();
    const items = await query
      .select(publicColumns.map((c) => `u.${c}` as const))
      .select((eb) =>
        eb
          .selectFrom('maintenance_task as t')
          .select((e) => e.fn.countAll<number>().as('n'))
          .whereRef('t.assigned_engineer_id', '=', 'u.id')
          .where('t.status', 'in', ENGINEER_OPEN)
          .as('open_tasks_count'),
      )
      .orderBy('u.full_name')
      .limit(q.page_size)
      .offset((q.page - 1) * q.page_size)
      .execute();
    return pageResult(items, total, q.page, q.page_size);
  });

  app.get('/users/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    return db.transaction().execute(async (trx) => {
      const user = requireRow(await trx.selectFrom('users').select(publicColumns).where('id', '=', id).executeTakeFirst(), 'Пользователь не найден');
      return { ...user, open_tasks: await openTasksOf(trx, id) };
    });
  });

  app.post('/users', admin, async (req, reply) => {
    const body = parse(CreateUser, req.body);
    const user = await db
      .insertInto('users')
      .values({ login: body.login, full_name: body.full_name, role: body.role, password_hash: await hashPassword(body.password) })
      .returning(publicColumns)
      .executeTakeFirstOrThrow();
    reply.status(201);
    return user;
  });

  app.patch('/users/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(UpdateUser, req.body);
    return db.transaction().execute(async (trx) => {
      const user = assertVersion(await trx.selectFrom('users').selectAll().where('id', '=', id).forUpdate().executeTakeFirst(), body.version, 'Пользователь');
      if (body.role && body.role !== user.role) {
        if (user.role === 'engineer') {
          const open = await openTasksOf(trx, id);
          if (open.length > 0) {
            throw conflict('engineer_has_tasks', 'Смена роли запрещена: у инженера есть незавершённые задания. Сначала передайте их другому инженеру.', { tasks: open });
          }
        }
        if (user.role === 'admin' && user.is_active) await assertNotLastAdmin(trx, id);
      }
      return trx
        .updateTable('users')
        .set({ login: body.login, full_name: body.full_name, role: body.role })
        .where('id', '=', id)
        .returning(publicColumns)
        .executeTakeFirstOrThrow();
    });
  });

  // UC 03: блокировка. Задания остаются за пользователем; сессии удаляются. Повтор безопасен.
  app.post('/users/:id/block', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    return db.transaction().execute(async (trx) => {
      const user = requireRow(await trx.selectFrom('users').selectAll().where('id', '=', id).forUpdate().executeTakeFirst(), 'Пользователь не найден');
      if (user.is_active) {
        if (user.role === 'admin') await assertNotLastAdmin(trx, id);
        await trx.updateTable('users').set({ is_active: false }).where('id', '=', id).execute();
      }
      await trx.deleteFrom('sessions').where('user_id', '=', id).execute();
      const updated = await trx.selectFrom('users').select(publicColumns).where('id', '=', id).executeTakeFirstOrThrow();
      return { ...updated, open_tasks: await openTasksOf(trx, id) };
    });
  });

  app.post('/users/:id/activate', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const user = await db
      .updateTable('users')
      .set({ is_active: true })
      .where('id', '=', id)
      .where('is_active', '=', false)
      .returning(publicColumns)
      .executeTakeFirst();
    return user ?? requireRow(await db.selectFrom('users').select(publicColumns).where('id', '=', id).executeTakeFirst(), 'Пользователь не найден');
  });

  // Сброс пароля администратором: все сессии пользователя завершаются.
  app.post('/users/:id/password', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(PasswordBody, req.body);
    const passwordHash = await hashPassword(body.password);
    const me = currentUser(req);
    const user = await db.transaction().execute(async (trx) => {
      assertVersion(await trx.selectFrom('users').select(['id', 'version']).where('id', '=', id).forUpdate().executeTakeFirst(), body.version, 'Пользователь');
      const updated = await trx.updateTable('users').set({ password_hash: passwordHash }).where('id', '=', id).returning(publicColumns).executeTakeFirstOrThrow();
      await trx.deleteFrom('sessions').where('user_id', '=', id).execute();
      return updated;
    });
    return { ...user, session_ended: me.id === id };
  });

  // Инженеры для назначения и фильтров (руководитель). Логинов и ролей в ответе нет.
  app.get('/engineers', { config: { roles: ['manager'] as Role[] } }, async (req) => {
    const q = parse(z.object({ include_inactive: boolQuery }), req.query);
    let query = db
      .selectFrom('users as u')
      .select(['u.id', 'u.full_name', 'u.is_active'])
      .select((eb) =>
        eb
          .selectFrom('maintenance_task as t')
          .select(sql<number>`count(*)`.as('n'))
          .whereRef('t.assigned_engineer_id', '=', 'u.id')
          .where('t.status', 'in', ENGINEER_OPEN)
          .as('open_tasks_count'),
      )
      .where('u.role', '=', 'engineer');
    if (!q.include_inactive) query = query.where('u.is_active', '=', true);
    return { items: await query.orderBy('u.full_name').execute() };
  });
}

