// UC 12–15, 19, 21 и приёмочные проверки уровня API.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../src/lib/dates.js';
import { createScenario, driveToReview, expectStatus, loginAs, resetDb, setupEnv, type Client, type TestEnv } from './helpers.js';

let env: TestEnv;
let manager: Client;
let eng1: Awaited<ReturnType<typeof loginAs>>;
let eng2: Awaited<ReturnType<typeof loginAs>>;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(() => env.close());
beforeEach(async () => {
  await resetDb(env.db);
  manager = (await loginAs(env, 'manager')).client;
  eng1 = await loginAs(env, 'engineer', 'Алексей Соколов');
  eng2 = await loginAs(env, 'engineer', 'Дмитрий Орлов');
});

async function newTask(opts: Parameters<typeof createScenario>[2] = {}) {
  const s = await createScenario(env, manager, { dueInDays: 1, ...opts });
  return { ...s, taskId: s.taskIds[0]! };
}
const getTask = async (id: number) => (await manager.get(`/tasks/${id}`)).body;

describe('доступ', () => {
  it('AT-01: инженер не видит и не меняет чужое задание', async () => {
    const { taskId } = await newTask();
    const t = await getTask(taskId);
    expectStatus(await manager.post(`/tasks/${taskId}/assign`, { version: t.version, engineer_id: eng1.user.id }), 200);

    const read = await eng2.client.get(`/tasks/${taskId}`);
    expect(read.status).toBe(403);
    expect(read.body).not.toHaveProperty('checks');
    expect((await eng2.client.get(`/tasks/${taskId}/history`)).status).toBe(403);
    expect((await eng2.client.post(`/tasks/${taskId}/start`, { version: 2 })).status).toBe(403);
    // в списке чужих заданий нет
    expect((await eng2.client.get('/tasks')).body.total).toBe(0);
    expect((await eng1.client.get('/tasks')).body.total).toBe(1);
    // инженер не пишет в справочники и не принимает
    expect((await eng1.client.post('/objects', { name: 'А', customer_name: 'Б', address: 'В' })).status).toBe(403);
    expect((await eng1.client.post(`/tasks/${taskId}/accept`, { version: 2 })).status).toBe(403);
  });

  it('AT-02: администратор не изменяет объект или шаблон', async () => {
    const { objectId } = await newTask();
    const { client: admin } = await loginAs(env, 'admin');
    expect((await admin.patch(`/objects/${objectId}`, { version: 1, name: 'Другое' })).status).toBe(403);
    expect((await admin.get('/templates')).status).toBe(403);
    expect((await admin.get('/tasks')).status).toBe(403);
    expect((await admin.get('/reports/maintenance')).status).toBe(403);
    // а руководитель не управляет пользователями
    expect((await manager.get('/users')).status).toBe(403);
  });
});

describe('выполнение и приёмка', () => {
  it('назначение, начало, черновик, отправка, приёмка; история с автором', async () => {
    const { taskId } = await newTask();
    let t = await getTask(taskId);
    expect(t.status).toBe('created');

    const a = await manager.post(`/tasks/${taskId}/assign`, { version: t.version, engineer_id: eng1.user.id });
    expect(a.body).toMatchObject({ status: 'assigned', engineer_name: 'Алексей Соколов' });
    const st = await eng1.client.post(`/tasks/${taskId}/start`, { version: a.body.version });
    expect(st.body.status).toBe('in_progress');

    // черновик: частично, статус не меняется
    const first = st.body.checks[0];
    const draft = await eng1.client.put(`/tasks/${taskId}/checks`, { version: st.body.version, checks: [{ id: first.id, result: 'passed', comment: null }], engineer_comment: 'Начали' });
    expectStatus(draft, 200);
    expect(draft.body.status).toBe('in_progress');
    expect(draft.body.checks[0]).toMatchObject({ result: 'passed', checked_by_name: 'Алексей Соколов' });

    t = await driveRest(taskId, draft.body);
    const acc = await manager.post(`/tasks/${taskId}/accept`, { version: t.version });
    expectStatus(acc, 200);
    expect(acc.body.status).toBe('accepted');
    expect(acc.body.accepted_at).toBeTruthy();

    const hist = (await manager.get(`/tasks/${taskId}/history`)).body.items;
    expect(hist.filter((h: { kind: string }) => h.kind === 'status').map((h: { new_status: string }) => h.new_status)).toEqual([
      'accepted', 'in_review', 'in_progress', 'assigned', 'created',
    ]);
    expect(hist.find((h: { kind: string }) => h.kind === 'assignment')).toMatchObject({ new_engineer_name: 'Алексей Соколов' });

    // после приёмки результаты не меняет никто
    expect((await eng1.client.put(`/tasks/${taskId}/checks`, { version: acc.body.version, checks: [] })).status).toBe(409);
  });

  async function driveRest(taskId: number, task: any) {
    const saved = await eng1.client.put(`/tasks/${taskId}/checks`, {
      version: task.version,
      checks: task.checks.map((c: { id: number }) => ({ id: c.id, result: 'passed', comment: null })),
    });
    expectStatus(saved, 200);
    const sub = await eng1.client.post(`/tasks/${taskId}/submit`, { version: saved.body.version, actual_performed_on: env.today });
    expectStatus(sub, 200);
    expect(sub.body.status).toBe('in_review');
    return sub.body;
  }

  it('AT-09: пустая обязательная проверка запрещает отправку', async () => {
    const { taskId } = await newTask();
    let t = await getTask(taskId);
    t = (await manager.post(`/tasks/${taskId}/assign`, { version: t.version, engineer_id: eng1.user.id })).body;
    t = (await eng1.client.post(`/tasks/${taskId}/start`, { version: t.version })).body;
    const required = t.checks.filter((c: { is_required: boolean }) => c.is_required);
    t = (await eng1.client.put(`/tasks/${taskId}/checks`, { version: t.version, checks: required.slice(1).map((c: { id: number }) => ({ id: c.id, result: 'passed' })) })).body;

    const sub = await eng1.client.post(`/tasks/${taskId}/submit`, { version: t.version, actual_performed_on: env.today });
    expect(sub.status).toBe(409);
    expect(sub.body.code).toBe('required_checks_empty');
    expect(sub.body.details.check_ids).toEqual([required[0].id]);
  });

  it('комментарий обязателен для результатов, кроме «Соответствует»', async () => {
    const { taskId } = await newTask();
    let t = await getTask(taskId);
    t = (await manager.post(`/tasks/${taskId}/assign`, { version: t.version, engineer_id: eng1.user.id })).body;
    t = (await eng1.client.post(`/tasks/${taskId}/start`, { version: t.version })).body;
    const res = await eng1.client.put(`/tasks/${taskId}/checks`, {
      version: t.version,
      checks: [
        { id: t.checks[0].id, result: 'passed' },
        { id: t.checks[1].id, result: 'not_applicable', comment: '   ' },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.field_errors['checks[1].comment']).toBeTruthy();
    // всё или ничего: первый пункт тоже не сохранён
    expect((await getTask(taskId)).checks[0].result).toBeNull();
  });

  it('фактическая дата не в будущем и не раньше создания задания', async () => {
    const { taskId } = await newTask();
    const fill = () => ({ result: 'passed' });
    let t = await getTask(taskId);
    t = (await manager.post(`/tasks/${taskId}/assign`, { version: t.version, engineer_id: eng1.user.id })).body;
    t = (await eng1.client.post(`/tasks/${taskId}/start`, { version: t.version })).body;
    t = (await eng1.client.put(`/tasks/${taskId}/checks`, { version: t.version, checks: t.checks.map((c: { id: number }) => ({ id: c.id, ...fill() })) })).body;
    const future = await eng1.client.post(`/tasks/${taskId}/submit`, { version: t.version, actual_performed_on: addDays(env.today, 1) });
    expect(future.body.field_errors.actual_performed_on).toBeTruthy();
    const past = await eng1.client.post(`/tasks/${taskId}/submit`, { version: t.version, actual_performed_on: addDays(env.today, -1) });
    expect(past.body.field_errors.actual_performed_on).toBeTruthy();
  });

  it('AT-10: обязательный «не проверено» с причиной — отправка разрешена, приёмка запрещена', async () => {
    const { taskId } = await newTask();
    const t = await driveToReview(env, manager, eng1, taskId, (c, i) =>
      i === 0 ? { result: 'not_checked', comment: 'Нет доступа к посту охраны' } : { result: 'passed' },
    );
    expect(t.status).toBe('in_review');
    expect(t.is_partial).toBe(true);
    const acc = await manager.post(`/tasks/${taskId}/accept`, { version: t.version });
    expect(acc.status).toBe(409);
    expect(acc.body.code).toBe('partial_result');
  });

  it('AT-11: полное ТО с замечанием о дефекте можно принять; карточки ремонта нет', async () => {
    const { taskId } = await newTask();
    const t = await driveToReview(env, manager, eng1, taskId, (c, i) =>
      i === 1 ? { result: 'deviation', comment: 'Изображение размыто, требуется очистка стекла' } : { result: 'passed' },
    );
    expect(t.is_partial).toBe(false);
    const acc = await manager.post(`/tasks/${taskId}/accept`, { version: t.version });
    expectStatus(acc, 200);
    expect(acc.body.status).toBe('accepted');
  });

  it('AT-12: возврат без комментария запрещён; с комментарием — «На доработке», повторная отправка в истории', async () => {
    const { taskId } = await newTask();
    const t = await driveToReview(env, manager, eng1, taskId);
    const empty = await manager.post(`/tasks/${taskId}/return`, { version: t.version, comment: '  ' });
    expect(empty.status).toBe(400);
    expect(empty.body.field_errors.comment).toBeTruthy();

    const ret = await manager.post(`/tasks/${taskId}/return`, { version: t.version, comment: 'Дополните пункт по оповещателям' });
    expect(ret.body).toMatchObject({ status: 'rework', review_comment: 'Дополните пункт по оповещателям' });

    // инженер правит тот же результат и отправляет снова
    const saved = await eng1.client.put(`/tasks/${taskId}/checks`, { version: ret.body.version, checks: [{ id: ret.body.checks[0].id, result: 'deviation', comment: 'Уточнено' }] });
    const again = await eng1.client.post(`/tasks/${taskId}/submit`, { version: saved.body.version, actual_performed_on: env.today });
    expect(again.body.status).toBe('in_review');
    const statuses = (await manager.get(`/tasks/${taskId}/history`)).body.items.filter((h: { kind: string }) => h.kind === 'status');
    expect(statuses.filter((h: { new_status: string }) => h.new_status === 'in_review')).toHaveLength(2);
  });

  it('AT-13: смена исполнителя в работе сохраняет результаты, прежний теряет изменение', async () => {
    const { taskId } = await newTask();
    let t = await getTask(taskId);
    t = (await manager.post(`/tasks/${taskId}/assign`, { version: t.version, engineer_id: eng1.user.id })).body;
    t = (await eng1.client.post(`/tasks/${taskId}/start`, { version: t.version })).body;
    t = (await eng1.client.put(`/tasks/${taskId}/checks`, { version: t.version, checks: [{ id: t.checks[0].id, result: 'passed' }] })).body;

    const re = await manager.post(`/tasks/${taskId}/assign`, { version: t.version, engineer_id: eng2.user.id });
    expectStatus(re, 200);
    expect(re.body.status).toBe('in_progress'); // статус не меняется
    expect(re.body.checks[0].result).toBe('passed');

    expect((await eng1.client.put(`/tasks/${taskId}/checks`, { version: re.body.version, checks: [] })).status).toBe(403);
    expectStatus(await eng2.client.put(`/tasks/${taskId}/checks`, { version: re.body.version, checks: [{ id: t.checks[1].id, result: 'passed' }] }), 200);
    // только активный инженер
    const notEngineer = await manager.post(`/tasks/${taskId}/assign`, { version: re.body.version + 1, engineer_id: (await loginAs(env, 'manager')).user.id });
    expect(notEngineer.status).toBe(400);
  });

  it('задание на проверке: сначала возврат, потом замена исполнителя', async () => {
    const { taskId } = await newTask();
    const t = await driveToReview(env, manager, eng1, taskId);
    const res = await manager.post(`/tasks/${taskId}/assign`, { version: t.version, engineer_id: eng2.user.id });
    expect(res.status).toBe(409);
  });

  it('AT-14: переименование оборудования видно в старом задании, результаты прежние', async () => {
    const { taskId, equipmentIds } = await newTask();
    const t = await driveToReview(env, manager, eng1, taskId);
    expectStatus(await manager.post(`/tasks/${taskId}/accept`, { version: t.version }), 200);

    const eq = (await manager.get(`/equipment?system_id=${t.system_id}`)).body.items.find((e: { id: number }) => e.id === equipmentIds[0]);
    expectStatus(await manager.patch(`/equipment/${eq.id}`, { version: eq.version, name: 'Камера К-01 (вход)' }), 200);

    const after = await getTask(taskId);
    expect(after.checks.find((c: { equipment_id: number }) => c.equipment_id === eq.id).equipment_name).toBe('Камера К-01 (вход)');
    expect(after.checks.every((c: { result: string }) => c.result === 'passed')).toBe(true);
  });

  it('AT-15: удаление с историей и вывод с открытым ТО запрещены с пояснением', async () => {
    const { taskId, equipmentIds, systemId, objectId } = await newTask();
    const del = await manager.del(`/equipment/${equipmentIds[0]}`);
    expect(del.status).toBe(409);
    expect(del.body.message).toMatch(/вывод из эксплуатации/i);

    const eq = (await manager.get(`/equipment?system_id=${systemId}`)).body.items[0];
    const dec = await manager.post(`/equipment/${eq.id}/decommission`, { version: eq.version, decommissioned_on: env.today, reason: 'Износ' });
    expect(dec.status).toBe(409);
    expect(dec.body.code).toBe('open_tasks');
    expect(dec.body.message).toContain((await getTask(taskId)).task_number);

    expect((await manager.del(`/systems/${systemId}`)).status).toBe(409);
    expect((await manager.del(`/objects/${objectId}`)).status).toBe(409);

    // после отмены задания вывод разрешён, удаление с историей — по-прежнему нет
    const t = await getTask(taskId);
    expectStatus(await manager.post(`/tasks/${taskId}/cancel`, { version: t.version, reason: 'Нет доступа' }), 200);
    const ok = await manager.post(`/equipment/${eq.id}/decommission`, { version: eq.version, decommissioned_on: env.today, reason: 'Износ' });
    expectStatus(ok, 200);
    expect(ok.body.lifecycle_status).toBe('decommissioned');
    expect((await manager.del(`/equipment/${eq.id}`)).status).toBe(409);
  });

  it('пустая карточка удаляется', async () => {
    const obj = await manager.post('/objects', { name: 'Пустой', customer_name: 'З', address: 'А' });
    expectStatus(await manager.del(`/objects/${obj.body.id}`), 204);
    expect((await manager.get(`/objects/${obj.body.id}`)).status).toBe(404);
  });

  it('тип системы не меняется при наличии оборудования', async () => {
    const { systemId } = await newTask({ activate: false });
    const sys = (await manager.get(`/systems/${systemId}`)).body;
    expect(sys.type_locked).toBe(true);
    const res = await manager.patch(`/systems/${systemId}`, { version: sys.version, system_type: 'fire_alarm' });
    expect(res.status).toBe(409);
  });

  it('AT-18: одновременная приёмка и отмена — одна успешна, другая конфликт', async () => {
    const { taskId } = await newTask();
    const t = await driveToReview(env, manager, eng1, taskId);
    const [acc, can] = await Promise.all([
      manager.post(`/tasks/${taskId}/accept`, { version: t.version }),
      manager.post(`/tasks/${taskId}/cancel`, { version: t.version, reason: 'Одновременно' }),
    ]);
    expect([acc.status, can.status].sort()).toEqual([200, 409]);
    const final = await getTask(taskId);
    expect(['accepted', 'cancelled']).toContain(final.status);
  });
});

describe('сроки и отмена', () => {
  it('AT-07: перенос одного задания — исходная дата и график неизменны, история есть', async () => {
    const { taskId, regulationId } = await newTask();
    const regBefore = (await manager.get(`/regulations/${regulationId}`)).body;
    const t = await getTask(taskId);
    const newDate = addDays(t.current_due_date, 4);

    const same = await manager.post(`/tasks/${taskId}/reschedule`, { version: t.version, new_due_date: t.current_due_date, reason: 'Та же' });
    expect(same.body.field_errors.new_due_date).toBeTruthy();
    const noReason = await manager.post(`/tasks/${taskId}/reschedule`, { version: t.version, new_due_date: newDate, reason: '' });
    expect(noReason.body.field_errors.reason).toBeTruthy();

    const res = await manager.post(`/tasks/${taskId}/reschedule`, { version: t.version, new_due_date: newDate, reason: 'Нет доступа к объекту' });
    expectStatus(res, 200);
    expect(res.body).toMatchObject({ original_due_date: t.original_due_date, current_due_date: newDate, has_deadline_violation: false });

    const regAfter = (await manager.get(`/regulations/${regulationId}`)).body;
    expect(regAfter.next_due_date).toBe(regBefore.next_due_date);
    expect(regAfter.schedule_anchor_date).toBe(regBefore.schedule_anchor_date);
    const hist = (await manager.get(`/tasks/${taskId}/history`)).body.items.find((h: { kind: string }) => h.kind === 'deadline');
    expect(hist).toMatchObject({ previous_due_date: t.current_due_date, new_due_date: newDate, reason: 'Нет доступа к объекту' });

    // конфликт версии
    const stale = await manager.post(`/tasks/${taskId}/reschedule`, { version: t.version, new_due_date: addDays(newDate, 1), reason: 'Ещё' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
  });

  it('принятое и отменённое не переносятся, принятое не отменяется, повтор отмены безопасен', async () => {
    const a = await newTask();
    const t = await driveToReview(env, manager, eng1, a.taskId);
    const acc = (await manager.post(`/tasks/${a.taskId}/accept`, { version: t.version })).body;
    expect((await manager.post(`/tasks/${a.taskId}/reschedule`, { version: acc.version, new_due_date: addDays(env.today, 9), reason: 'x' })).status).toBe(409);
    expect((await manager.post(`/tasks/${a.taskId}/cancel`, { version: acc.version, reason: 'x' })).status).toBe(409);

    const b = await newTask();
    const tb = await getTask(b.taskId);
    const c1 = await manager.post(`/tasks/${b.taskId}/cancel`, { version: tb.version, reason: 'Объект закрыт' });
    expectStatus(c1, 200);
    const c2 = await manager.post(`/tasks/${b.taskId}/cancel`, { version: tb.version, reason: 'Объект закрыт' });
    expectStatus(c2, 200);
    expect(c2.body).toMatchObject({ status: 'cancelled', cancellation_reason: 'Объект закрыт', version: c1.body.version });
    expect((await manager.post(`/tasks/${b.taskId}/reschedule`, { version: c1.body.version, new_due_date: addDays(env.today, 9), reason: 'x' })).status).toBe(409);
  });

  it('UC 19: фильтры списка и вкладки', async () => {
    const a = await newTask({ type: 'video_surveillance' });
    const b = await newTask({ type: 'fire_alarm' });
    const tb = await getTask(b.taskId);
    await manager.post(`/tasks/${b.taskId}/cancel`, { version: tb.version, reason: 'x' });

    expect((await manager.get('/tasks?system_type=fire_alarm')).body.items.map((t: { id: number }) => t.id)).toEqual([b.taskId]);
    expect((await manager.get(`/tasks?object_id=${a.objectId}`)).body.total).toBe(1);
    expect((await manager.get('/tasks?view=cancelled')).body.items.map((t: { id: number }) => t.id)).toEqual([b.taskId]);
    expect((await manager.get('/tasks?status=created,assigned')).body.items.map((t: { id: number }) => t.id)).toEqual([a.taskId]);
    expect((await manager.get('/tasks?view=overdue')).body.total).toBe(0);
    const paged = await manager.get('/tasks?page=2&page_size=1');
    expect(paged.body).toMatchObject({ total: 2, page: 2, page_size: 1 });
    expect(paged.body.items).toHaveLength(1);
  });
});
