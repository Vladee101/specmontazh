// UC 01–03: вход, сессии, CSRF, блокировка (AT-21), пользователи.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, createScenario, createUser, expectStatus, login, loginAs, PASSWORD, resetDb, setupEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(() => env.close());
beforeEach(() => resetDb(env.db));

describe('вход и сессия', () => {
  it('верные данные открывают сессию, /auth/me возвращает пользователя', async () => {
    const user = await createUser(env.db, 'manager', 'Михаил Петров');
    const client = await login(env.app, user.login.toUpperCase()); // логин без учёта регистра
    const me = await client.get('/auth/me');
    expectStatus(me, 200);
    expect(me.body.user).toMatchObject({ id: user.id, role: 'manager', full_name: 'Михаил Петров' });
    expect(me.body.csrf_token).toBe(client.csrf);
  });

  it('неверный пароль и несуществующий логин дают одно общее сообщение', async () => {
    const user = await createUser(env.db, 'engineer');
    const a = await new Client(env.app).post('/auth/login', { login: user.login, password: 'wrong-password' });
    const b = await new Client(env.app).post('/auth/login', { login: 'nobody', password: 'wrong-password' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('заблокированному вход запрещён', async () => {
    const user = await createUser(env.db, 'engineer');
    await env.db.updateTable('users').set({ is_active: false }).where('id', '=', user.id).execute();
    const res = await new Client(env.app).post('/auth/login', { login: user.login, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('user_blocked');
  });

  it('без входа — 401, выход завершает сессию', async () => {
    expect((await new Client(env.app).get('/tasks')).status).toBe(401);
    const { client } = await loginAs(env, 'manager');
    expectStatus(await client.post('/auth/logout'), 200);
    expect((await client.get('/auth/me')).status).toBe(401);
  });

  it('изменяющий запрос без CSRF-токена отклоняется', async () => {
    const { client } = await loginAs(env, 'manager');
    const csrf = client.csrf;
    client.csrf = null;
    const res = await client.post('/objects', { name: 'А', customer_name: 'Б', address: 'В' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('csrf_failed');
    client.csrf = csrf;
    expectStatus(await client.post('/objects', { name: 'А', customer_name: 'Б', address: 'В' }), 201);
  });

  it('сессия истекает после 8 часов простоя', async () => {
    const { client, user } = await loginAs(env, 'manager');
    await env.db.updateTable('sessions').set({ last_seen_at: new Date(Date.now() - 8 * 3600_000 - 1000) }).where('user_id', '=', user.id).execute();
    expect((await client.get('/auth/me')).status).toBe(401);
  });

  it('пароль хранится хешем', async () => {
    const { client: admin } = await loginAs(env, 'admin');
    const res = await admin.post('/users', { login: 'new.user', full_name: 'Новый Пользователь', role: 'engineer', password: 'secret-pass-1' });
    expectStatus(res, 201);
    expect(res.body).not.toHaveProperty('password_hash');
    const row = await env.db.selectFrom('users').select('password_hash').where('id', '=', res.body.id).executeTakeFirstOrThrow();
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain('secret-pass-1');
  });
});

describe('AT-21: блокировка пользователя с сессией', () => {
  it('после блокировки дальнейшие операции запрещены, после активации сессия не восстанавливается', async () => {
    const { client: admin } = await loginAs(env, 'admin');
    const { client: engineer, user } = await loginAs(env, 'engineer');
    expectStatus(await engineer.get('/tasks'), 200);

    expectStatus(await admin.post(`/users/${user.id}/block`), 200);
    expect((await engineer.get('/tasks')).status).toBe(401);
    // повтор безопасен
    expectStatus(await admin.post(`/users/${user.id}/block`), 200);

    expectStatus(await admin.post(`/users/${user.id}/activate`), 200);
    expect((await engineer.get('/tasks')).status).toBe(401);
    expectStatus(await (await login(env.app, user.login)).get('/tasks'), 200);
  });

  it('незавершённые задания показываются и блокировке не мешают', async () => {
    const { client: admin } = await loginAs(env, 'admin');
    const { client: manager } = await loginAs(env, 'manager');
    const eng = await createUser(env.db, 'engineer');
    const s = await createScenario(env, manager);
    const task = (await manager.get(`/tasks/${s.taskIds[0]}`)).body;
    expectStatus(await manager.post(`/tasks/${task.id}/assign`, { version: task.version, engineer_id: eng.id }), 200);

    const res = await admin.post(`/users/${eng.id}/block`);
    expectStatus(res, 200);
    expect(res.body.is_active).toBe(false);
    expect(res.body.open_tasks).toHaveLength(1);
  });
});

describe('UC 02: правила пользователей', () => {
  it('логин уникален без учёта регистра', async () => {
    const { client: admin } = await loginAs(env, 'admin');
    expectStatus(await admin.post('/users', { login: 'Ivanov', full_name: 'И', role: 'engineer', password: 'password-1' }), 201);
    const dup = await admin.post('/users', { login: 'ivanov', full_name: 'И2', role: 'engineer', password: 'password-1' });
    expect(dup.status).toBe(400);
    expect(dup.body.field_errors.login).toBeTruthy();
  });

  it('нельзя заблокировать или разжаловать последнего активного администратора', async () => {
    const { client: admin, user } = await loginAs(env, 'admin');
    expect((await admin.post(`/users/${user.id}/block`)).body.code).toBe('last_admin');
    const res = await admin.patch(`/users/${user.id}`, { version: user.version, role: 'manager' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('last_admin');
  });

  it('смена роли инженера с незавершёнными назначениями запрещена', async () => {
    const { client: admin } = await loginAs(env, 'admin');
    const { client: manager } = await loginAs(env, 'manager');
    const eng = await createUser(env.db, 'engineer');
    const s = await createScenario(env, manager);
    const task = (await manager.get(`/tasks/${s.taskIds[0]}`)).body;
    expectStatus(await manager.post(`/tasks/${task.id}/assign`, { version: task.version, engineer_id: eng.id }), 200);

    const res = await admin.patch(`/users/${eng.id}`, { version: eng.version, role: 'manager' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('engineer_has_tasks');
  });

  it('сброс пароля завершает сессии пользователя', async () => {
    const { client: admin } = await loginAs(env, 'admin');
    const { client: engineer, user } = await loginAs(env, 'engineer');
    expectStatus(await admin.post(`/users/${user.id}/password`, { version: user.version, password: 'brand-new-pass' }), 200);
    expect((await engineer.get('/tasks')).status).toBe(401);
    await expect(login(env.app, user.login)).rejects.toThrow();
    expectStatus(await (await login(env.app, user.login, 'brand-new-pass')).get('/tasks'), 200);
  });

  it('список инженеров для руководителя — без логинов, только активные', async () => {
    const { client: manager } = await loginAs(env, 'manager');
    const active = await createUser(env.db, 'engineer', 'Активный');
    const blocked = await createUser(env.db, 'engineer', 'Заблокированный');
    await env.db.updateTable('users').set({ is_active: false }).where('id', '=', blocked.id).execute();
    const res = await manager.get('/engineers');
    expectStatus(res, 200);
    expect(res.body.items.map((e: { id: number }) => e.id)).toEqual([active.id]);
    expect(res.body.items[0]).not.toHaveProperty('login');
    const all = await manager.get('/engineers?include_inactive=true');
    expect(all.body.items).toHaveLength(2);
  });
});
