// Команда: node dist/perf/seed.js — стенд для замера производительности:
// 100 объектов, ~5000 устройств, ~10 000 заданий во всех статусах.
// Работает только с отдельной базой, имя которой оканчивается на _perf.
//
// Задания создаёт та же функция генерации, что и планировщик (по регламентам с
// опорной датой в прошлом). Затем задания проводятся по статусам теми же
// переходами, что разрешает триггер trg_task_guard, с записью истории.
import { sql, type RawBuilder } from 'kysely';
import { loadConfig } from '../config.js';
import { createDb, type Db, type Trx } from '../db/index.js';
import { migrate } from '../db/migrator.js';
import { seedTemplates } from '../db/seed.js';
import type { SystemType, TaskStatus } from '../db/types.js';
import { addDays, addMonths, dateIn } from '../lib/dates.js';
import { hashPassword } from '../lib/password.js';
import { generateForRegulation } from '../services/generation.js';

const OBJECTS = 100;
const EQUIPMENT = 5000;
const TASKS = 10_000;
const ENGINEERS = 10;
export const PERF_PASSWORD = process.env.PERF_PASSWORD || 'perf-pass-1';

// Состав системы: «главное» устройство и массовое (их большинство)
const KIT: Record<SystemType, { name: string; main: [string, string]; bulk: [string, string] }> = {
  fire_alarm: { name: 'Пожарная сигнализация', main: ['Приёмно-контрольный прибор', 'ПКП'], bulk: ['Извещатель', 'ИП'] },
  evacuation_alert: { name: 'СОУЭ', main: ['Усилитель', 'УС'], bulk: ['Оповещатель', 'ОП'] },
  security_alarm: { name: 'Охранная сигнализация', main: ['Приёмно-контрольный прибор', 'ПКП'], bulk: ['Извещатель', 'ИО'] },
  video_surveillance: { name: 'Видеонаблюдение', main: ['Видеорегистратор', 'ВР'], bulk: ['Камера', 'К'] },
};
const TYPES = Object.keys(KIT) as SystemType[];

/** Детерминированный «случай»: одинаковые данные при каждом запуске. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function dbName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

async function createCatalog(db: Db, today: string, managerId: number) {
  const rand = rng(42);
  // 3–4 системы на объект; устройства делятся между системами поровну
  const systems: { objectIndex: number; type: SystemType }[] = [];
  for (let o = 0; o < OBJECTS; o++) {
    const n = o % 2 === 0 ? 4 : 3;
    for (let k = 0; k < n; k++) systems.push({ objectIndex: o, type: TYPES[(o + k) % TYPES.length]! });
  }
  const perSystem = EQUIPMENT / systems.length;

  return db.transaction().execute(async (trx) => {
    const objects = await trx
      .insertInto('service_object')
      .values(
        Array.from({ length: OBJECTS }, (_, i) => ({
          created_by_id: managerId,
          name: `Объект ${String(i + 1).padStart(3, '0')}`,
          customer_name: `ООО «Заказчик ${(i % 37) + 1}»`,
          address: `ул. Тестовая, ${i + 1}`,
          contact_name: `Контакт ${i + 1}`,
          contact_phone: `+7 (900) 000-${String(i).padStart(2, '0')}-00`,
        })),
      )
      .returning('id')
      .execute();

    const sysRows = await trx
      .insertInto('low_current_system')
      .values(systems.map((s) => ({ object_id: objects[s.objectIndex]!.id, name: KIT[s.type].name, system_type: s.type })))
      .returning(['id', 'system_type'])
      .execute();

    let made = 0;
    const equipment: object[] = [];
    sysRows.forEach((sys, i) => {
      const kit = KIT[sys.system_type];
      const count = Math.round(perSystem * (i + 1)) - made;
      made += count;
      const mains = sys.system_type === 'video_surveillance' ? 2 : 1;
      for (let e = 0; e < count; e++) {
        const [type, prefix] = e < mains ? kit.main : kit.bulk;
        // ~3 % устройств выведены из эксплуатации: в новые задания не попадают
        const decommissioned = e >= mains && rand() < 0.03;
        equipment.push({
          system_id: sys.id,
          name: `${prefix}-${String(e + 1).padStart(2, '0')}`,
          equipment_type: type,
          model: `Модель ${(e % 5) + 1}`,
          serial_number: `SN${sys.id}-${e + 1}`,
          location: `Этаж ${(e % 5) + 1}, зона ${(e % 7) + 1}`,
          installed_on: addMonths(today, -48),
          ...(decommissioned ? { lifecycle_status: 'decommissioned', decommissioned_on: addMonths(today, -30), decommission_reason: 'Физический износ' } : {}),
        });
      }
    });
    for (let i = 0; i < equipment.length; i += 1000) {
      await trx.insertInto('equipment').values(equipment.slice(i, i + 1000) as never).execute();
    }
    return { objects: objects.length, systems: sysRows, equipment: equipment.length };
  });
}

/** Регламенты с опорной датой в прошлом: генерация создаёт задания за прошедшие месяцы. */
async function createTasks(db: Db, today: string, managerId: number, systems: { id: number; system_type: SystemType }[]) {
  // месяц сверху: первые сроки сдвинуты по дням месяца, заданий должно быть не меньше TASKS
  const months = Math.ceil(TASKS / systems.length) + 1;
  const templates = new Map((await db.selectFrom('checklist_template').select(['id', 'system_type']).execute()).map((t) => [t.system_type, t.id]));
  const start = addMonths(today, -months + 1);
  let created = 0;
  for (const [i, sys] of systems.entries()) {
    // сроки разнесены по дням месяца, чтобы задания не приходились на одну дату
    const anchor = addDays(start, i % 28);
    if (created >= TASKS) break;
    await db.transaction().execute(async (trx) => {
      const reg = await trx
        .insertInto('maintenance_regulation')
        .values({
          system_id: sys.id, template_id: templates.get(sys.system_type)!, created_by_id: managerId, name: `ТО: ${KIT[sys.system_type].name}`,
          interval_value: 1, schedule_anchor_date: anchor, next_due_date: anchor, status: 'active', activated_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      created += (await generateForRegulation(trx, reg.id, today, 5)).length;
    });
  }
  return created;
}

type Plan = { id: number; due: string; engineer: number; final: TaskStatus; late: number; reschedule: boolean; partial: boolean };

/** Итоговый статус задания по сроку: прошлые в основном приняты, ближайшие — в работе. */
function plan(tasks: { id: number; original_due_date: string; object_id: number }[], engineers: number[], today: string): Plan[] {
  const rand = rng(7);
  return tasks.map((t) => {
    const r = rand();
    let final: TaskStatus;
    if (t.original_due_date > today) final = r < 0.5 ? 'created' : 'assigned';
    else if (t.original_due_date >= addDays(today, -14))
      final = r < 0.1 ? 'accepted' : r < 0.4 ? 'in_review' : r < 0.5 ? 'rework' : r < 0.75 ? 'in_progress' : r < 0.95 ? 'assigned' : 'created';
    // старые: 92 % приняты, 5 % отменены, остальное зависло (просрочка)
    else final = r < 0.92 ? 'accepted' : r < 0.97 ? 'cancelled' : r < 0.985 ? 'assigned' : 'in_progress';
    return {
      id: t.id,
      due: t.original_due_date,
      engineer: engineers[t.object_id % engineers.length]!,
      final,
      // ~15 % выполнены позже срока (нарушение срока), остальные в срок или на день раньше
      late: rand() < 0.15 ? 1 + Math.floor(rand() * 5) : -Math.floor(rand() * 2),
      reschedule: rand() < 0.04,
      partial: final === 'in_review' && rand() < 0.1,
    };
  });
}

type RawSql = RawBuilder<unknown>;

const ids = (rows: Plan[], pick: (p: Plan) => boolean) => rows.filter(pick).map((p) => p.id);

/** Смена статуса группы заданий с записью истории; время события — от исходного срока. */
async function transition(
  trx: Trx,
  taskIds: number[],
  from: TaskStatus[],
  to: TaskStatus,
  set: RawSql,
  at: RawSql,
  by: number | 'engineer',
  comment: string | null = null,
) {
  if (taskIds.length === 0) return;
  // прежний статус берётся до обновления (old), действие — от руководителя или назначенного инженера
  await sql`
    WITH old AS (
      SELECT id AS old_id, status AS old_status FROM maintenance_task
       WHERE id = ANY(${taskIds}::bigint[]) AND status = ANY(${from}::text[])
    ), moved AS (
      UPDATE maintenance_task t SET status = ${to}, ${set}
        FROM old WHERE t.id = old.old_id
      RETURNING t.id, old.old_status AS previous_status, t.assigned_engineer_id, t.original_due_date, t.actual_performed_on
    )
    INSERT INTO task_status_history (task_id, changed_by_id, previous_status, new_status, comment, actual_performed_on, changed_at)
    SELECT m.id, ${by === 'engineer' ? sql`m.assigned_engineer_id` : sql`${by}::bigint`}, m.previous_status, ${to}, ${comment},
           ${to === 'in_review' ? sql`m.actual_performed_on` : sql`NULL`}, ${at}
      FROM moved m`.execute(trx);
}

async function driveStatuses(db: Db, today: string, managerId: number, engineers: number[]) {
  const tasks = await db
    .selectFrom('maintenance_task as t')
    .innerJoin('low_current_system as s', 's.id', 't.system_id')
    .select(['t.id', 't.original_due_date', 's.object_id'])
    .orderBy('t.id')
    .execute();
  const p = plan(tasks, engineers, today);
  const byId = new Map(p.map((x) => [x.id, x]));
  const started: TaskStatus[] = ['in_progress', 'in_review', 'rework', 'accepted'];
  const submitted: TaskStatus[] = ['in_review', 'rework', 'accepted'];

  await db.transaction().execute(async (trx) => {
    // назначение: всё, кроме «Создано» и отменённых до назначения
    const assign = ids(p, (x) => x.final !== 'created' && !(x.final === 'cancelled' && x.id % 2 === 0));
    for (const e of engineers) {
      const mine = assign.filter((id) => byId.get(id)!.engineer === e);
      await transition(trx, mine, ['created'], 'assigned', sql`assigned_engineer_id = ${e}`, sql`m.original_due_date - 7 + time '09:00'`, managerId);
      if (mine.length) {
        await sql`
          INSERT INTO task_assignment_history (task_id, previous_engineer_id, new_engineer_id, changed_by_id, changed_at)
          SELECT id, NULL, ${e}, ${managerId}, original_due_date - 7 + time '09:00' FROM maintenance_task WHERE id = ANY(${mine}::bigint[])`.execute(trx);
      }
    }

    // перенос срока на неделю у ~4 % (до начала работ)
    const moved = ids(p, (x) => x.reschedule && x.final !== 'created');
    if (moved.length) {
      await sql`
        WITH c AS (
          UPDATE maintenance_task SET current_due_date = original_due_date + 7 WHERE id = ANY(${moved}::bigint[])
          RETURNING id, original_due_date
        )
        INSERT INTO task_deadline_change (task_id, changed_by_id, previous_due_date, new_due_date, reason, changed_at)
        SELECT id, ${managerId}, original_due_date, original_due_date + 7, 'Перенос по просьбе заказчика', original_due_date - 5 + time '10:00' FROM c`.execute(trx);
    }

    await transition(trx, ids(p, (x) => started.includes(x.final)), ['assigned'], 'in_progress', sql`started_at = original_due_date - 1 + time '09:00'`, sql`m.original_due_date - 1 + time '09:00'`, 'engineer');

    // результаты проверок: в работе — заполнена половина, отправленные — все
    const full = ids(p, (x) => submitted.includes(x.final));
    const half = ids(p, (x) => x.final === 'in_progress');
    const partial = ids(p, (x) => x.partial);
    const fill = sql`
      result = CASE
          WHEN c.task_id = ANY(${partial}::bigint[]) AND c.position = 1 THEN 'not_checked'
          WHEN abs(hashint4(c.id::int)) % 100 < 4 THEN 'deviation'
          WHEN abs(hashint4(c.id::int)) % 100 < 6 THEN 'not_applicable'
          WHEN NOT c.is_required AND abs(hashint4(c.id::int)) % 100 < 8 THEN 'not_checked'
          ELSE 'passed' END,
      comment = CASE
          WHEN c.task_id = ANY(${partial}::bigint[]) AND c.position = 1 THEN 'Нет доступа в помещение'
          WHEN abs(hashint4(c.id::int)) % 100 < 4 THEN 'Загрязнение корпуса, требуется очистка'
          WHEN abs(hashint4(c.id::int)) % 100 < 6 THEN 'Не используется на объекте'
          WHEN NOT c.is_required AND abs(hashint4(c.id::int)) % 100 < 8 THEN 'Не успели в смену'
          ELSE NULL END,
      checked_by_id = t.assigned_engineer_id,
      checked_at = t.original_due_date + time '12:00'`;
    await sql`UPDATE task_check c SET ${fill} FROM maintenance_task t WHERE t.id = c.task_id AND c.task_id = ANY(${full}::bigint[])`.execute(trx);
    await sql`
      UPDATE task_check c SET ${fill} FROM maintenance_task t
       WHERE t.id = c.task_id AND c.task_id = ANY(${half}::bigint[])
         AND c.position <= (SELECT count(*) / 2 FROM task_check x WHERE x.task_id = c.task_id)`.execute(trx);

    // отправка: фактическая дата — срок ± сдвиг, не позже сегодняшнего дня
    for (const late of new Set(p.map((x) => x.late))) {
      const group = ids(p, (x) => submitted.includes(x.final) && x.late === late);
      await transition(
        trx, group, ['in_progress'], 'in_review',
        sql`actual_performed_on = least(original_due_date + ${late}::int, ${today}::date),
            submitted_at = least(original_due_date + ${late}::int, ${today}::date) + time '17:00',
            is_partial = id = ANY(${partial}::bigint[]),
            engineer_comment = CASE WHEN id % 10 = 0 THEN 'Работы выполнены, замечания в чек-листе' END`,
        sql`m.actual_performed_on + time '17:00'`, 'engineer',
      );
    }

    await transition(trx, ids(p, (x) => x.final === 'rework'), ['in_review'], 'rework', sql`review_comment = 'Уточните комментарий по отклонениям'`, sql`m.actual_performed_on + time '18:00'`, managerId, 'Уточните комментарий по отклонениям');
    await transition(
      trx, ids(p, (x) => x.final === 'accepted'), ['in_review'], 'accepted',
      sql`accepted_at = least(actual_performed_on + 2 + time '10:00', now()), reviewed_by_id = ${managerId}`,
      sql`least(m.actual_performed_on + 2 + time '10:00', now())`, managerId,
    );
    await transition(
      trx, ids(p, (x) => x.final === 'cancelled'), ['created', 'assigned'], 'cancelled',
      sql`cancelled_at = original_due_date - 2 + time '11:00', cancelled_by_id = ${managerId}, cancellation_reason = 'Объект закрыт на ремонт'`,
      sql`m.original_due_date - 2 + time '11:00'`, managerId, 'Объект закрыт на ремонт',
    );
  });

  const counts = await db.selectFrom('maintenance_task').select(['status', db.fn.countAll<number>().as('n')]).groupBy('status').orderBy('status').execute();
  return counts.map((c) => `${c.status}: ${c.n}`).join(', ');
}

const config = loadConfig();
const name = dbName(config.databaseUrl);
if (!name.endsWith('_perf')) {
  console.error(`Стенд создаётся только в базе с именем *_perf, а указана «${name}». Рабочая база не трогается.`);
  process.exit(1);
}

const db = createDb(config.databaseUrl, 2);
try {
  const t0 = Date.now();
  await migrate(db, config.migrationsDir);
  await seedTemplates(db);
  if (await db.selectFrom('maintenance_task').select('id').executeTakeFirst()) {
    throw new Error(`В базе ${name} уже есть задания. Пересоздайте её: dropdb ${name} && createdb ${name}`);
  }
  const today = dateIn(config.timeZone, new Date());
  const hash = await hashPassword(PERF_PASSWORD);
  const users = await db
    .insertInto('users')
    .values([
      { login: 'perf.manager', full_name: 'Руководитель стенда', role: 'manager', password_hash: hash },
      ...Array.from({ length: ENGINEERS }, (_, i) => ({ login: `perf.eng${String(i + 1).padStart(2, '0')}`, full_name: `Инженер ${i + 1}`, role: 'engineer' as const, password_hash: hash })),
    ])
    .returning(['id', 'role'])
    .execute();
  const managerId = users.find((u) => u.role === 'manager')!.id;
  const engineers = users.filter((u) => u.role === 'engineer').map((u) => u.id);

  const catalog = await createCatalog(db, today, managerId);
  console.log(`объектов ${catalog.objects}, систем ${catalog.systems.length}, устройств ${catalog.equipment}`);
  const tasks = await createTasks(db, today, managerId, catalog.systems);
  console.log(`заданий создано генерацией: ${tasks}`);
  console.log(`статусы: ${await driveStatuses(db, today, managerId, engineers)}`);
  await sql`ANALYZE`.execute(db);

  const checks = await db.selectFrom('task_check').select(db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  console.log(`проверок в чек-листах: ${checks.n}; готово за ${Math.round((Date.now() - t0) / 1000)} с`);
  console.log(`вход: perf.manager, perf.eng01…perf.eng${ENGINEERS}, пароль ${PERF_PASSWORD === 'perf-pass-1' ? 'perf-pass-1' : 'из PERF_PASSWORD'}`);
} finally {
  await db.destroy();
}
