import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db/index.js';
import { seedTemplates } from '../src/db/seed.js';
import type { Role, SystemType } from '../src/db/types.js';
import type { AppContext } from '../src/http/context.js';
import { addDays, dateIn } from '../src/lib/dates.js';
import { hashPassword } from '../src/lib/password.js';

export const PASSWORD = 'test-password-1';
const TABLES = [
  'sessions', 'task_status_history', 'task_assignment_history', 'task_deadline_change', 'task_check', 'task_equipment',
  'maintenance_task', 'maintenance_regulation', 'template_item', 'checklist_template', 'equipment', 'low_current_system',
  'service_object', 'users',
];

export interface TestEnv {
  app: FastifyInstance;
  db: Db;
  ctx: AppContext;
  /** Сегодня по Москве (по реальным часам: представление v_task_report считает просрочку от now() БД). */
  today: string;
  close(): Promise<void>;
}

export async function setupEnv(): Promise<TestEnv> {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres@localhost:54329/sm_to_test';
  const config = loadConfig({ DATABASE_URL: url, NODE_ENV: 'test', LOGIN_RATE_LIMIT: '1000', TZ: 'Europe/Moscow' });
  const db = createDb(url, 5);
  const ctx: AppContext = { db, config, now: () => new Date() };
  const app = await buildApp(ctx, { logger: false });
  await app.ready();
  return {
    app,
    db,
    ctx,
    today: dateIn(config.timeZone, new Date()),
    close: async () => {
      await app.close();
      await db.destroy();
    },
  };
}

export async function resetDb(db: Db): Promise<void> {
  await sql.raw(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE; ALTER SEQUENCE task_number_seq RESTART;`).execute(db);
  await seedTemplates(db);
}

let userSeq = 0;
const passwordHash = hashPassword(PASSWORD);

export async function createUser(db: Db, role: Role, fullName?: string) {
  userSeq += 1;
  const login = `${role}${userSeq}`;
  const user = await db
    .insertInto('users')
    .values({ login, full_name: fullName ?? `${role} ${userSeq}`, role, password_hash: await passwordHash })
    .returning(['id', 'login', 'full_name', 'role', 'version'])
    .executeTakeFirstOrThrow();
  return user;
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
  text: string;
}

export class Client {
  constructor(
    private app: FastifyInstance,
    private cookie: string | null = null,
    public csrf: string | null = null,
  ) {}

  async request<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const h: Record<string, string> = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf && method !== 'GET') h['x-csrf-token'] = this.csrf;
    const res = await this.app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: h });
    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
      const first = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;
      this.cookie = first.endsWith('=') ? null : first;
    }
    let body: any = res.body;
    if (String(res.headers['content-type'] ?? '').includes('application/json')) body = res.json();
    return { status: res.statusCode, body, headers: res.headers, text: res.body };
  }

  get = <T = any>(url: string) => this.request<T>('GET', url);
  post = <T = any>(url: string, body: unknown = {}) => this.request<T>('POST', url, body);
  put = <T = any>(url: string, body: unknown = {}) => this.request<T>('PUT', url, body);
  patch = <T = any>(url: string, body: unknown = {}) => this.request<T>('PATCH', url, body);
  del = <T = any>(url: string, body?: unknown) => this.request<T>('DELETE', url, body);
}

export async function login(app: FastifyInstance, loginName: string, password = PASSWORD): Promise<Client> {
  const client = new Client(app);
  const res = await client.post('/auth/login', { login: loginName, password });
  if (res.status !== 200) throw new Error(`вход ${loginName}: ${res.status} ${JSON.stringify(res.body)}`);
  client.csrf = res.body.csrf_token;
  return client;
}

export async function loginAs(env: TestEnv, role: Role, fullName?: string) {
  const user = await createUser(env.db, role, fullName);
  return { user, client: await login(env.app, user.login) };
}

const EQUIPMENT_BY_TYPE: Record<SystemType, [string, string][]> = {
  video_surveillance: [['Камера К-01', 'Камера'], ['Камера К-02', 'Камера'], ['Видеорегистратор ВР-01', 'Видеорегистратор']],
  fire_alarm: [['Прибор ПКП-01', 'Приёмно-контрольный прибор'], ['Извещатель ИП-01', 'Извещатель']],
  security_alarm: [['Прибор ПКП-02', 'Приёмно-контрольный прибор'], ['Извещатель ИО-01', 'Извещатель']],
  evacuation_alert: [['Оповещатель ОП-01', 'Оповещатель'], ['Усилитель УС-01', 'Усилитель']],
};

export interface Scenario {
  objectId: number;
  systemId: number;
  regulationId: number;
  equipmentIds: number[];
  taskIds: number[];
}

/** Объект → система с оборудованием → регламент; при activate — активация (и генерация в окне 5 дней). */
export async function createScenario(
  env: TestEnv,
  manager: Client,
  opts: { type?: SystemType; dueInDays?: number; interval?: number; activate?: boolean; equipment?: [string, string][] } = {},
): Promise<Scenario> {
  const type = opts.type ?? 'video_surveillance';
  const obj = await manager.post('/objects', { name: `Объект ${Math.random().toString(36).slice(2, 7)}`, customer_name: 'ООО «Тест»', address: 'ул. Тестовая, 1' });
  expectStatus(obj, 201);
  const sys = await manager.post('/systems', { object_id: obj.body.id, name: 'Система', system_type: type });
  expectStatus(sys, 201);
  const equipmentIds: number[] = [];
  for (const [name, equipment_type] of opts.equipment ?? EQUIPMENT_BY_TYPE[type]) {
    const eq = await manager.post('/equipment', { system_id: sys.body.id, name, equipment_type });
    expectStatus(eq, 201);
    equipmentIds.push(eq.body.id);
  }
  const reg = await manager.post('/regulations', {
    system_id: sys.body.id,
    name: 'Регламент',
    interval_value: opts.interval ?? 1,
    first_due_date: addDays(env.today, opts.dueInDays ?? 3),
  });
  expectStatus(reg, 201);
  let taskIds: number[] = [];
  if (opts.activate !== false) {
    const act = await manager.post(`/regulations/${reg.body.id}/activate`, { version: reg.body.version });
    expectStatus(act, 200);
    taskIds = act.body.created_tasks.map((t: { id: number }) => t.id);
  }
  return { objectId: obj.body.id, systemId: sys.body.id, regulationId: reg.body.id, equipmentIds, taskIds };
}

export function expectStatus(res: Res, status: number): void {
  if (res.status !== status) {
    throw new Error(`ожидали ${status}, получили ${res.status}: ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`);
  }
}

/** Проводит задание до «На проверке»: назначение, начало, заполнение всех пунктов, отправка. */
export async function driveToReview(
  env: TestEnv,
  manager: Client,
  engineer: { client: Client; user: { id: number } },
  taskId: number,
  fill: (check: { id: number; is_required: boolean }, i: number) => { result: string | null; comment?: string | null } = () => ({ result: 'passed' }),
) {
  let task = (await manager.get(`/tasks/${taskId}`)).body;
  const assigned = await manager.post(`/tasks/${taskId}/assign`, { version: task.version, engineer_id: engineer.user.id });
  expectStatus(assigned, 200);
  const started = await engineer.client.post(`/tasks/${taskId}/start`, { version: assigned.body.version });
  expectStatus(started, 200);
  task = started.body;
  const saved = await engineer.client.put(`/tasks/${taskId}/checks`, {
    version: task.version,
    checks: task.checks.map((c: { id: number; is_required: boolean }, i: number) => ({ id: c.id, comment: null, ...fill(c, i) })),
  });
  expectStatus(saved, 200);
  const submitted = await engineer.client.post(`/tasks/${taskId}/submit`, { version: saved.body.version, actual_performed_on: env.today });
  expectStatus(submitted, 200);
  return submitted.body;
}
