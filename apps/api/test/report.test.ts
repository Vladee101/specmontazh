// UC 20: отчёт и CSV; AT-17, AT-19, AT-20.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../src/lib/dates.js';
import { CSV_COLUMNS, CSV_HEADER, type CsvColumn } from '../src/services/report.js';
import { createScenario, driveToReview, expectStatus, loginAs, resetDb, setupEnv, type Client, type TestEnv } from './helpers.js';

let env: TestEnv;
let manager: Client;
let eng: Awaited<ReturnType<typeof loginAs>>;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(() => env.close());
beforeEach(async () => {
  await resetDb(env.db);
  manager = (await loginAs(env, 'manager')).client;
  eng = await loginAs(env, 'engineer', 'Алексей Соколов');
});

const parseCsv = (text: string) => text.replace(/^﻿/, '').trimEnd().split('\r\n').map((l) => l.split(';'));

describe('нарушение срока (v_task_report)', () => {
  it('AT-17: перенос до срока — нарушения нет; поздний перенос не стирает факт', async () => {
    const early = (await createScenario(env, manager, { dueInDays: 2 })).taskIds[0]!;
    let t = (await manager.get(`/tasks/${early}`)).body;
    t = (await manager.post(`/tasks/${early}/reschedule`, { version: t.version, new_due_date: addDays(env.today, 6), reason: 'Заранее' })).body;
    expect(t).toMatchObject({ is_overdue: false, has_deadline_violation: false });

    const late = (await createScenario(env, manager, { dueInDays: 1 })).taskIds[0]!;
    // срок уже истёк: текущий срок вчера
    await env.db.updateTable('maintenance_task').set({ current_due_date: addDays(env.today, -1) }).where('id', '=', late).execute();
    let l = (await manager.get(`/tasks/${late}`)).body;
    expect(l).toMatchObject({ is_overdue: true, has_deadline_violation: true });
    l = (await manager.post(`/tasks/${late}/reschedule`, { version: l.version, new_due_date: addDays(env.today, 3), reason: 'Поздно' })).body;
    expect(l).toMatchObject({ is_overdue: false, has_deadline_violation: true });
  });
});

describe('отчёт', () => {
  it('AT-19: выборка по исходной дате после переноса и отмены; причины и замечания в CSV', async () => {
    const a = (await createScenario(env, manager, { dueInDays: 1 })).taskIds[0]!;
    const b = (await createScenario(env, manager, { dueInDays: 2, type: 'fire_alarm' })).taskIds[0]!;

    // a: перенос далеко за пределы периода + замечание + комментарий инженера + приёмка
    let ta = (await manager.get(`/tasks/${a}`)).body;
    ta = (await manager.post(`/tasks/${a}/reschedule`, { version: ta.version, new_due_date: addDays(env.today, 40), reason: 'Перенос по просьбе заказчика' })).body;
    const reviewed = await driveToReview(env, manager, eng, a, (_c, i) => (i === 0 ? { result: 'deviation', comment: 'Стекло камеры загрязнено' } : { result: 'passed' }));
    expectStatus(await manager.post(`/tasks/${a}/accept`, { version: reviewed.version }), 200);
    // b: отмена
    const tb = (await manager.get(`/tasks/${b}`)).body;
    expectStatus(await manager.post(`/tasks/${b}/cancel`, { version: tb.version, reason: 'Объект закрыт на ремонт' }), 200);

    const period = `date_from=${env.today}&date_to=${addDays(env.today, 5)}`;
    const report = await manager.get(`/reports/maintenance?${period}`);
    expectStatus(report, 200);
    expect(report.body.items.map((r: { id: number }) => r.id)).toEqual([a, b]); // перенесённое осталось в исходном периоде
    expect(report.body.summary).toMatchObject({ total: 2, accepted: 1, cancelled: 1, not_completed: 0 });

    const csv = await manager.get(`/reports/maintenance.csv?${period}`);
    expectStatus(csv, 200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(csv.text);
    expect(rows[0]).toEqual([...CSV_HEADER]);
    expect(rows[0]![0]).toBe('Номер задания');
    expect(rows).toHaveLength(3);
    const col = (key: CsvColumn) => CSV_COLUMNS.findIndex(([k]) => k === key);
    const rowA = rows[1]!;
    expect(rowA[col('status')]).toBe('Принято');
    expect(rowA[col('original_due_date')]).toBe(addDays(env.today, 1));
    expect(rowA[col('current_due_date')]).toBe(addDays(env.today, 40));
    expect(rowA[col('remarks')]).toContain('Стекло камеры загрязнено');
    expect(rowA[col('system_type')]).toBe('Видеонаблюдение');
    expect(rowA[col('is_partial')]).toBe('Нет');
    expect(rowA[col('accepted_at')]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const rowB = rows[2]!;
    expect(rowB[col('status')]).toBe('Отменено');
    expect(rowB[col('cancellation_reason')]).toBe('Объект закрыт на ремонт');
    // причина переноса в замечания не попадает
    expect(csv.text).not.toContain('Перенос по просьбе заказчика');

    // таблица и CSV — одна выборка: тот же набор и порядок
    expect(rows.slice(1).map((r) => r[0])).toEqual(report.body.items.map((r: { task_number: string }) => r.task_number));
  });

  it('AT-20: пустой период даёт строку заголовков; опасный текст не становится формулой', async () => {
    const empty = await manager.get('/reports/maintenance.csv?date_from=2000-01-01&date_to=2000-01-31');
    expectStatus(empty, 200);
    expect(parseCsv(empty.text)).toEqual([[...CSV_HEADER]]);

    const s = await createScenario(env, manager, { dueInDays: 1 });
    await env.db.updateTable('service_object').set({ name: '=HYPERLINK("http://evil")', customer_name: '+7 900', address: '@SUM(A1)' }).where('id', '=', s.objectId).execute();
    const t = (await manager.get(`/tasks/${s.taskIds[0]}`)).body;
    expectStatus(await manager.post(`/tasks/${t.id}/cancel`, { version: t.version, reason: '-1;DROP' }), 200);

    const csv = await manager.get(`/reports/maintenance.csv?date_from=${env.today}&date_to=${addDays(env.today, 5)}`);
    const line = csv.text.split('\r\n')[1]!;
    expect(line).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(line).toContain("'+7 900");
    expect(line).toContain("'@SUM(A1)");
    expect(line).toContain(`"'-1;DROP"`);
  });

  it('фильтры отчёта: тип системы, исполнитель, статус', async () => {
    const a = (await createScenario(env, manager, { dueInDays: 1 })).taskIds[0]!;
    await createScenario(env, manager, { dueInDays: 1, type: 'fire_alarm' });
    const t = (await manager.get(`/tasks/${a}`)).body;
    await manager.post(`/tasks/${a}/assign`, { version: t.version, engineer_id: eng.user.id });

    const q = (s: string) => manager.get(`/reports/maintenance?date_from=${env.today}&date_to=${addDays(env.today, 5)}&${s}`);
    expect((await q('system_type=fire_alarm')).body.items).toHaveLength(1);
    expect((await q(`engineer_id=${eng.user.id}`)).body.items.map((r: { id: number }) => r.id)).toEqual([a]);
    expect((await q('status=assigned')).body.items).toHaveLength(1);
    expect((await manager.get(`/reports/maintenance?date_from=${addDays(env.today, 5)}&date_to=${env.today}`)).status).toBe(400);
  });
});
