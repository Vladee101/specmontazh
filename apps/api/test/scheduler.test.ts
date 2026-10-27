// UC 10–11: регламенты и генерация заданий.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../src/lib/dates.js';
import { runScheduler } from '../src/services/generation.js';
import { createScenario, expectStatus, loginAs, resetDb, setupEnv, type Client, type TestEnv } from './helpers.js';

let env: TestEnv;
let manager: Client;
const silent = { info: () => {}, error: () => {} };

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(() => env.close());
beforeEach(async () => {
  await resetDb(env.db);
  manager = (await loginAs(env, 'manager')).client;
});

const run = (today: string) => runScheduler(env.db, today, 5, silent);
const tasksOf = (regulationId: number) =>
  env.db.selectFrom('maintenance_task').selectAll().where('regulation_id', '=', regulationId).orderBy('original_due_date').execute();

describe('генерация заданий', () => {
  it('AT-03: ТО через 5 дней; два запуска дают одно задание с копиями проверок', async () => {
    const s = await createScenario(env, manager, { dueInDays: 10 });
    expect(s.taskIds).toHaveLength(0); // вне окна — сразу не создаётся

    const due = addDays(env.today, 10);
    const day = addDays(due, -5);
    expect((await run(addDays(day, -1))).created).toHaveLength(0);
    expect((await run(day)).created).toHaveLength(1);
    expect((await run(day)).created).toHaveLength(0);

    const tasks = await tasksOf(s.regulationId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'created', original_due_date: due, current_due_date: due });
    expect(tasks[0]!.task_number).toMatch(/^ТО-\d{6}$/);

    // видеонаблюдение: 2 пункта на регистратор, 2 × 2 камеры, 1 по системе = 7 проверок
    const checks = await env.db.selectFrom('task_check').selectAll().where('task_id', '=', tasks[0]!.id).orderBy('position').execute();
    expect(checks).toHaveLength(7);
    expect(checks.map((c) => c.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(checks.filter((c) => c.task_equipment_id === null)).toHaveLength(1);
    const history = await env.db.selectFrom('task_status_history').selectAll().where('task_id', '=', tasks[0]!.id).execute();
    expect(history).toMatchObject([{ previous_status: null, new_status: 'created', changed_by_id: null }]);
  });

  it('фильтр типов: проверка камеры не появляется у регистратора', async () => {
    const s = await createScenario(env, manager, { dueInDays: 1 });
    const checks = await env.db
      .selectFrom('task_check as c')
      .innerJoin('task_equipment as te', 'te.id', 'c.task_equipment_id')
      .innerJoin('equipment as e', 'e.id', 'te.equipment_id')
      .select(['c.check_text', 'e.equipment_type'])
      .where('c.task_id', '=', s.taskIds[0]!)
      .execute();
    for (const c of checks) {
      if (c.check_text.includes('камер') || c.check_text.includes('изображения')) expect(c.equipment_type).toBe('Камера');
      if (c.check_text.includes('архива') || c.check_text.includes('накопителей')) expect(c.equipment_type).toBe('Видеорегистратор');
    }
  });

  it('AT-04: регламент, подключённый за 2 дня до срока, создаёт задание сразу; исторических нет', async () => {
    const s = await createScenario(env, manager, { dueInDays: 2 });
    expect(s.taskIds).toHaveLength(1);
    const tasks = await tasksOf(s.regulationId);
    expect(tasks.map((t) => t.original_due_date)).toEqual([addDays(env.today, 2)]);
  });

  it('первая дата в прошлом запрещена', async () => {
    const s = await createScenario(env, manager, { activate: false });
    const res = await manager.post('/regulations', { system_id: s.systemId, name: 'Р', interval_value: 1, first_due_date: addDays(env.today, -1) });
    expect(res.status).toBe(400);
    expect(res.body.field_errors.first_due_date).toBeTruthy();
    const zero = await manager.post('/regulations', { system_id: s.systemId, name: 'Р', interval_value: 0, first_due_date: env.today });
    expect(zero.body.field_errors.interval_value).toBeTruthy();
  });

  it('AT-05: сбой восполняется без дублей, пауза не восполняется', async () => {
    const s = await createScenario(env, manager, { dueInDays: 0 }); // ежемесячно, срок сегодня — создано сразу
    expect(s.taskIds).toHaveLength(1);

    // планировщик «не работал» два месяца: запуск восстанавливает оба пропущенных срока
    const later = addDays(env.today, 62);
    const restored = await run(later);
    expect(restored.created.length).toBeGreaterThanOrEqual(2);
    const afterRestore = await tasksOf(s.regulationId);
    expect(new Set(afterRestore.map((t) => t.original_due_date)).size).toBe(afterRestore.length);

    // пауза: задания не создаются и не копятся
    let reg = (await manager.get(`/regulations/${s.regulationId}`)).body;
    expectStatus(await manager.post(`/regulations/${s.regulationId}/pause`, { version: reg.version }), 200);
    expect((await run(addDays(env.today, 200))).created).toHaveLength(0);

    // возобновление: новая ближайшая дата, пропущенное за паузу не создаётся
    reg = (await manager.get(`/regulations/${s.regulationId}`)).body;
    const resumeDate = addDays(env.today, 1);
    const resumed = await manager.post(`/regulations/${s.regulationId}/resume`, { version: reg.version, next_due_date: resumeDate });
    expectStatus(resumed, 200);
    expect(resumed.body.regulation.schedule_anchor_date).toBe(resumeDate);
    const all = await tasksOf(s.regulationId);
    const before = new Set(afterRestore.map((t) => t.id));
    expect(all.filter((t) => !before.has(t.id)).map((t) => t.original_due_date)).toEqual([resumeDate]);
  });

  it('AT-08: отменённое задание при повторной генерации не создаётся заново', async () => {
    const s = await createScenario(env, manager, { dueInDays: 1 });
    const task = (await manager.get(`/tasks/${s.taskIds[0]}`)).body;
    expectStatus(await manager.post(`/tasks/${task.id}/cancel`, { version: task.version, reason: 'Объект закрыт' }), 200);

    // повторная генерация на ту же дату: регламент «откатили» к сроку отменённого задания
    await env.db.updateTable('maintenance_regulation').set({ next_due_date: task.original_due_date }).where('id', '=', s.regulationId).execute();
    expect((await run(env.today)).created).toHaveLength(0);
    const tasks = await tasksOf(s.regulationId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe('cancelled');
  });

  it('пустой чек-лист — ошибка настройки: активация откатывается, срок не продвигается', async () => {
    // охранная сигнализация без оборудования: пункты по системе есть, значит не пусто — берём шаблон только с пунктами по оборудованию
    const tpl = await env.db.selectFrom('checklist_template').select('id').where('system_type', '=', 'evacuation_alert').executeTakeFirstOrThrow();
    await env.db.deleteFrom('template_item').where('template_id', '=', tpl.id).where('target_type', '=', 'system').execute();
    const s = await createScenario(env, manager, { type: 'evacuation_alert', dueInDays: 1, activate: false, equipment: [] });
    const reg = (await manager.get(`/regulations/${s.regulationId}`)).body;
    const res = await manager.post(`/regulations/${s.regulationId}/activate`, { version: reg.version });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('empty_checklist');
    const after = (await manager.get(`/regulations/${s.regulationId}`)).body;
    expect(after.status).toBe('draft');
    expect(after.next_due_date).toBe(reg.next_due_date);
  });

  it('ошибка одного регламента не мешает остальным', async () => {
    const good = await createScenario(env, manager, { dueInDays: 10 });
    const bad = await createScenario(env, manager, { type: 'fire_alarm', dueInDays: 10 });
    // у «плохого» вывели всё оборудование и убрали пункт по системе — чек-лист станет пустым
    await env.db.updateTable('equipment').set({ lifecycle_status: 'decommissioned', decommissioned_on: env.today, decommission_reason: 'тест' }).where('system_id', '=', bad.systemId).execute();
    const tpl = await env.db.selectFrom('checklist_template').select('id').where('system_type', '=', 'fire_alarm').executeTakeFirstOrThrow();
    await env.db.deleteFrom('template_item').where('template_id', '=', tpl.id).where('target_type', '=', 'system').execute();

    const summary = await run(addDays(env.today, 5));
    expect(summary.created).toHaveLength(1);
    expect(summary.failed.map((f) => f.regulation_id)).toEqual([bad.regulationId]);
    expect(await tasksOf(good.regulationId)).toHaveLength(1);
    const badReg = await env.db.selectFrom('maintenance_regulation').select('next_due_date').where('id', '=', bad.regulationId).executeTakeFirstOrThrow();
    expect(badReg.next_due_date).toBe(addDays(env.today, 10));
  });

  it('AT-16: архивирование после отмены открытых заданий успешно, новая генерация прекращена', async () => {
    const s = await createScenario(env, manager, { dueInDays: 1 });
    let obj = (await manager.get(`/objects/${s.objectId}`)).body;
    const blocked = await manager.post(`/objects/${s.objectId}/archive`, { version: obj.version });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('open_tasks');

    const task = (await manager.get(`/tasks/${s.taskIds[0]}`)).body;
    expectStatus(await manager.post(`/tasks/${task.id}/cancel`, { version: task.version, reason: 'Объект закрывается' }), 200);
    obj = (await manager.get(`/objects/${s.objectId}`)).body;
    expectStatus(await manager.post(`/objects/${s.objectId}/archive`, { version: obj.version }), 200);

    const reg = (await manager.get(`/regulations/${s.regulationId}`)).body;
    expect(reg.status).toBe('paused');
    expect((await run(addDays(env.today, 100))).created).toHaveLength(0);
    // и заново активировать на архивном объекте нельзя (триггер БД)
    const resume = await manager.post(`/regulations/${s.regulationId}/resume`, { version: reg.version, next_due_date: addDays(env.today, 1) });
    expect(resume.status).toBe(409);
  });

  it('AT-22: правка шаблона после выдачи ТО не меняет старый чек-лист, новые задания обновлены', async () => {
    const s = await createScenario(env, manager, { type: 'fire_alarm', dueInDays: 1, interval: 3 });
    const oldChecks = await env.db.selectFrom('task_check').select(['check_text', 'is_required']).where('task_id', '=', s.taskIds[0]!).orderBy('position').execute();

    const tpl = (await manager.get('/templates')).body.items.find((t: { system_type: string }) => t.system_type === 'fire_alarm');
    const detail = (await manager.get(`/templates/${tpl.id}`)).body;
    const first = detail.items[0];
    const edited = await manager.patch(`/templates/${tpl.id}/items/${first.id}`, {
      version: detail.version,
      section_name: first.section_name,
      check_text: 'Новый текст проверки прибора',
      target_type: first.target_type,
      equipment_type_filter: first.equipment_type_filter,
      is_required: false,
    });
    expectStatus(edited, 200);
    const last = detail.items.at(-1);
    expectStatus(await manager.del(`/templates/${tpl.id}/items/${last.id}`, { version: edited.body.template_version }), 200);

    const stillOld = await env.db.selectFrom('task_check').select(['check_text', 'is_required']).where('task_id', '=', s.taskIds[0]!).orderBy('position').execute();
    expect(stillOld).toEqual(oldChecks);

    expectStatus(await manager.post(`/tasks/${s.taskIds[0]}/cancel`, { version: 1, reason: 'для следующего' }), 200);
    const next = await run(addDays(env.today, 95)); // квартальный регламент: следующий срок через 3 месяца
    expect(next.created).toHaveLength(1);
    const newChecks = await env.db.selectFrom('task_check').select(['check_text', 'is_required']).where('task_id', '=', next.created[0]!.id).orderBy('position').execute();
    expect(newChecks.some((c) => c.check_text === 'Новый текст проверки прибора' && !c.is_required)).toBe(true);
    expect(newChecks.some((c) => c.check_text === oldChecks.at(-1)!.check_text)).toBe(false);
  });

  it('шаблон: порядок пунктов, последний пункт и неактивность при действующих регламентах', async () => {
    await createScenario(env, manager, { type: 'security_alarm', dueInDays: 1 });
    const tpl = (await manager.get('/templates')).body.items.find((t: { system_type: string }) => t.system_type === 'security_alarm');
    let detail = (await manager.get(`/templates/${tpl.id}`)).body;
    const ids = detail.items.map((i: { id: number }) => i.id);
    const reordered = await manager.put(`/templates/${tpl.id}/items/order`, { version: detail.version, item_ids: [...ids].reverse() });
    expectStatus(reordered, 200);
    detail = (await manager.get(`/templates/${tpl.id}`)).body;
    expect(detail.items.map((i: { id: number }) => i.id)).toEqual([...ids].reverse());
    expect(detail.items.map((i: { position: number }) => i.position)).toEqual([1, 2, 3]);

    const stale = await manager.put(`/templates/${tpl.id}/items/order`, { version: 1, item_ids: ids });
    expect(stale.status).toBe(409);

    const off = await manager.patch(`/templates/${tpl.id}`, { version: detail.version, is_active: false });
    expect(off.body.code).toBe('template_in_use');
  });
});
