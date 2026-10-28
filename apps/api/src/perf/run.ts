// Команда: node dist/perf/run.js [адрес API] — замер типичных запросов на стенде.
// API запускается отдельно на базе стенда (node dist/perf/seed.js). Каждый запрос
// выполняется RUNS раз подряд после прогрева; выводятся медиана, 95-й процентиль
// и максимум. Требование: не более 2 секунд (README, «Производительность»).
import { addDays, dateIn } from '../lib/dates.js';

const BASE = (process.argv[2] ?? process.env.PERF_URL ?? 'http://127.0.0.1:3011').replace(/\/$/, '') + '/api/v1';
const PASSWORD = process.env.PERF_PASSWORD || 'perf-pass-1';
const RUNS = Number(process.env.PERF_RUNS) || 20;
const LIMIT_MS = 2000;

class Client {
  private cookie = '';
  private csrf = '';

  async login(login: string) {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login, password: PASSWORD }),
    });
    if (!res.ok) throw new Error(`вход ${login}: ${res.status} ${await res.text()}`);
    this.cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    this.csrf = ((await res.json()) as { csrf_token: string }).csrf_token;
    return this;
  }

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ ms: number; bytes: number; data: T }> {
    const t0 = performance.now();
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { cookie: this.cookie, 'x-csrf-token': this.csrf, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    const data = (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text;
    return { ms, bytes: Buffer.byteLength(text), data: data as T };
  }

  get<T = unknown>(path: string) {
    return this.call<T>('GET', path);
  }
}

interface Page<T> {
  items: T[];
  total: number;
}
interface TaskItem {
  id: number;
  status: string;
  version: number;
}
interface Result {
  name: string;
  runs: number;
  median: number;
  p95: number;
  max: number;
  info: string;
}

const results: Result[] = [];

/** Прогрев (2 запуска) и RUNS замеров; fn получает номер запуска. */
async function measure(name: string, fn: (i: number) => Promise<{ ms: number; bytes: number }>, info = '', runs = RUNS, warmup = 2) {
  for (let i = 0; i < warmup; i++) await fn(-1 - i);
  const times: number[] = [];
  let bytes = 0;
  for (let i = 0; i < runs; i++) {
    const r = await fn(i);
    times.push(r.ms);
    bytes = r.bytes;
  }
  times.sort((a, b) => a - b);
  const at = (q: number) => times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)]!;
  const size = bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.round(bytes / 1024)} КБ`;
  results.push({ name, runs, median: at(0.5), p95: at(0.95), max: times.at(-1)!, info: [info, size].filter(Boolean).join(', ') });
  process.stdout.write('.');
}

const today = dateIn('Europe/Moscow', new Date());
const yearAgo = addDays(today, -365);

const manager = await new Client().login('perf.manager');
const engineer = await new Client().login('perf.eng01');

const all = await manager.get<Page<TaskItem>>('/tasks?page_size=1');
const objects = await manager.get<Page<{ id: number }>>('/objects?page_size=200');
console.log(`стенд: заданий ${all.data.total}, объектов ${objects.data.total}; замеров на запрос ${RUNS}`);

const lastPage = Math.ceil(all.data.total / 50);
const sample = (await manager.get<Page<TaskItem>>('/tasks?status=accepted&page_size=50')).data.items;
const objectId = objects.data.items[Math.floor(objects.data.items.length / 2)]!.id;
const systems = (await manager.get<{ items: { id: number }[] }>(`/systems?object_id=${objectId}`)).data.items;

// ---- руководитель: чтение ----
await measure('Список заданий, 1-я страница', () => manager.get('/tasks'));
await measure('Список заданий, последняя страница', () => manager.get(`/tasks?page=${lastPage}`), `стр. ${lastPage}`);
await measure('Вкладка «Просрочено»', () => manager.get('/tasks?view=overdue'));
await measure('Вкладка «На проверке»', () => manager.get('/tasks?view=in_review'));
await measure('Фильтр: тип системы + статус + период', () => manager.get(`/tasks?system_type=video_surveillance&status=accepted&due_from=${yearAgo}&due_to=${today}`));
await measure('Поиск по объекту', () => manager.get('/tasks?q=' + encodeURIComponent('Объект 05')));
await measure('Карточка задания с чек-листом', (i) => manager.get(`/tasks/${sample[Math.abs(i) % sample.length]!.id}`));
await measure('История задания', (i) => manager.get(`/tasks/${sample[Math.abs(i) % sample.length]!.id}/history`));
await measure('Список объектов', () => manager.get('/objects'));
await measure('Карточка объекта', () => manager.get(`/objects/${objectId}`));
await measure('Оборудование системы', (i) => manager.get(`/equipment?system_id=${systems[Math.abs(i) % systems.length]!.id}`));
await measure('Регламенты', () => manager.get('/regulations'));
const report = await manager.get<{ items: unknown[] }>(`/reports/maintenance?date_from=${yearAgo}&date_to=${today}`);
await measure('Отчёт за год', () => manager.get(`/reports/maintenance?date_from=${yearAgo}&date_to=${today}`), `${report.data.items.length} строк`, 10);
await measure('Выгрузка CSV за год', () => manager.get(`/reports/maintenance.csv?date_from=${yearAgo}&date_to=${today}`), `${report.data.items.length} строк`, 10);
const fullReport = await manager.get<{ items: unknown[] }>('/reports/maintenance');
await measure('Отчёт за весь период', () => manager.get('/reports/maintenance'), `${fullReport.data.items.length} строк`, 5, 1);
await measure('Выгрузка CSV за весь период', () => manager.get('/reports/maintenance.csv'), `${fullReport.data.items.length} строк`, 5, 1);

// ---- инженер ----
await measure('Мои задания (текущие)', () => engineer.get('/tasks?view=open'));
const mine = (await engineer.get<Page<TaskItem>>('/tasks?status=in_progress&page_size=200')).data.items;
if (mine.length === 0) throw new Error('у perf.eng01 нет заданий «В работе»');
await measure('Чек-лист задания', (i) => engineer.get(`/tasks/${mine[Math.abs(i) % mine.length]!.id}`));
// черновик: все проверки задания со значением «Соответствует»; версия берётся из ответа
const draftTask = (await engineer.get<{ id: number; version: number; checks: { id: number }[] }>(`/tasks/${mine[0]!.id}`)).data;
let draftVersion = draftTask.version;
await measure(
  'Сохранение черновика чек-листа',
  async () => {
    const r = await engineer.call<{ version: number }>('PUT', `/tasks/${draftTask.id}/checks`, {
      version: draftVersion,
      checks: draftTask.checks.map((c) => ({ id: c.id, result: 'passed', comment: null })),
    });
    draftVersion = r.data.version;
    return r;
  },
  `${draftTask.checks.length} проверок`,
);

// ---- руководитель: приёмка (каждый запуск — новое задание «На проверке», не частичное) ----
const inReview = (await manager.get<Page<TaskItem & { is_partial: boolean }>>('/tasks?view=in_review&page_size=200')).data.items.filter((t) => !t.is_partial);
const acceptRuns = Math.min(RUNS, inReview.length - 2);
if (acceptRuns > 0) {
  // версия есть только в карточке; карточки читаются до замера
  const review: TaskItem[] = [];
  for (const t of inReview.slice(0, acceptRuns + 2)) review.push((await manager.get<TaskItem>(`/tasks/${t.id}`)).data);
  await measure('Приёмка ТО', (i) => {
    const t = review[i < 0 ? -1 - i : i + 2]!;
    return manager.call('POST', `/tasks/${t.id}/accept`, { version: t.version });
  }, 'по одному заданию', acceptRuns);
} else {
  console.log('\nприёмка не замерена: на стенде не осталось заданий «На проверке» — пересоздайте стенд');
}

console.log('\n');
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
const ms = (v: number) => `${Math.round(v)} мс`;
console.log(`${pad('Запрос', 40)}${pad('медиана', 10)}${pad('95 %', 10)}${pad('макс.', 10)}данные`);
for (const r of results) console.log(`${pad(r.name, 40)}${pad(ms(r.median), 10)}${pad(ms(r.p95), 10)}${pad(ms(r.max), 10)}${r.info}`);

const slow = results.filter((r) => r.max > LIMIT_MS);
console.log(slow.length ? `\nПРЕВЫШЕН лимит 2 с: ${slow.map((r) => r.name).join('; ')}` : `\nВсе запросы уложились в 2 с (по максимуму из ${RUNS} замеров).`);

// таблица для README
console.log('\n| Запрос | Медиана | 95 % | Макс. | Данные |\n|---|---|---|---|---|');
for (const r of results) console.log(`| ${r.name} | ${ms(r.median)} | ${ms(r.p95)} | ${ms(r.max)} | ${r.info} |`);
process.exit(slow.length ? 1 : 0);
