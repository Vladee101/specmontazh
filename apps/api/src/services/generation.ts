// UC 11: генерация заданий по регламентам (спецификация, раздел 5).
// Одна транзакция на регламент: строка регламента блокируется FOR UPDATE,
// дубли дополнительно отсекает уникальный ключ (regulation_id, original_due_date).
import type { Db, Trx } from '../db/index.js';
import { conflict } from '../http/errors.js';
import { addDays, nextScheduledDate } from '../lib/dates.js';

export interface CreatedTask {
  id: number;
  task_number: string;
  original_due_date: string;
}

interface Logger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * Создаёт недостающие задания регламента со сроками до today + horizonDays включительно
 * и продвигает next_due_date. Вызывается внутри транзакции: планировщиком и сразу
 * после активации или возобновления регламента.
 * Пустой чек-лист — ошибка настройки: исключение откатывает транзакцию, срок не продвигается.
 */
export async function generateForRegulation(trx: Trx, regulationId: number, today: string, horizonDays: number): Promise<CreatedTask[]> {
  const reg = await trx
    .selectFrom('maintenance_regulation as r')
    .innerJoin('low_current_system as s', 's.id', 'r.system_id')
    .innerJoin('service_object as o', 'o.id', 's.object_id')
    .select([
      'r.id', 'r.name', 'r.system_id', 'r.template_id', 'r.status', 'r.interval_value',
      'r.schedule_anchor_date', 'r.next_due_date', 's.is_archived as system_archived', 'o.is_archived as object_archived',
    ])
    .where('r.id', '=', regulationId)
    .forUpdate('r')
    .executeTakeFirst();
  if (!reg || reg.status !== 'active' || reg.system_archived || reg.object_archived) return [];

  const limit = addDays(today, horizonDays);
  const created: CreatedTask[] = [];
  let due = reg.next_due_date;
  while (due <= limit) {
    const exists = await trx
      .selectFrom('maintenance_task')
      .select('id')
      .where('regulation_id', '=', reg.id)
      .where('original_due_date', '=', due)
      .executeTakeFirst();
    // существующее задание, в том числе отменённое, повторно не создаётся
    if (!exists) created.push(await createTask(trx, reg, due));
    due = nextScheduledDate(reg.schedule_anchor_date, due, reg.interval_value);
  }
  if (due !== reg.next_due_date) {
    await trx.updateTable('maintenance_regulation').set({ next_due_date: due }).where('id', '=', reg.id).execute();
  }
  return created;
}

async function createTask(
  trx: Trx,
  reg: { id: number; name: string; system_id: number; template_id: number },
  due: string,
): Promise<CreatedTask> {
  const equipment = await trx
    .selectFrom('equipment')
    .select(['id', 'equipment_type'])
    .where('system_id', '=', reg.system_id)
    .where('lifecycle_status', '=', 'active')
    .orderBy('name')
    .orderBy('id')
    .execute();
  const items = await trx.selectFrom('template_item').selectAll().where('template_id', '=', reg.template_id).orderBy('position').execute();

  // Фактический чек-лист: пункт по системе — одна проверка; пункт по оборудованию —
  // по проверке на каждое активное устройство подходящего типа.
  const plan: { item: (typeof items)[number]; equipmentId: number | null }[] = [];
  for (const item of items) {
    if (item.target_type === 'system') {
      plan.push({ item, equipmentId: null });
      continue;
    }
    for (const eq of equipment) {
      if (!item.equipment_type_filter || item.equipment_type_filter.includes(eq.equipment_type)) {
        plan.push({ item, equipmentId: eq.id });
      }
    }
  }
  if (plan.length === 0) {
    throw conflict('empty_checklist', `Регламент «${reg.name}»: для срока ${due} чек-лист пуст. Проверьте шаблон и оборудование системы.`, {
      regulation_id: reg.id,
      due_date: due,
    });
  }

  const task = await trx
    .insertInto('maintenance_task')
    .values({ regulation_id: reg.id, system_id: reg.system_id, original_due_date: due, current_due_date: due })
    .returning(['id', 'task_number', 'original_due_date'])
    .executeTakeFirstOrThrow();

  const taskEquipment = new Map<number, number>();
  if (equipment.length > 0) {
    const rows = await trx
      .insertInto('task_equipment')
      .values(equipment.map((e) => ({ task_id: task.id, equipment_id: e.id })))
      .returning(['id', 'equipment_id'])
      .execute();
    for (const r of rows) taskEquipment.set(r.equipment_id, r.id);
  }

  await trx
    .insertInto('task_check')
    .values(
      plan.map((p, i) => ({
        task_id: task.id,
        task_equipment_id: p.equipmentId === null ? null : taskEquipment.get(p.equipmentId)!,
        source_template_item_id: p.item.id,
        position: i + 1,
        section_name: p.item.section_name,
        check_text: p.item.check_text,
        is_required: p.item.is_required,
      })),
    )
    .execute();

  await trx.insertInto('task_status_history').values({ task_id: task.id, changed_by_id: null, previous_status: null, new_status: 'created' }).execute();
  return task;
}

export interface SchedulerSummary {
  today: string;
  regulations: number;
  created: CreatedTask[];
  failed: { regulation_id: number; error: string }[];
}

/** Запуск планировщика: каждый регламент — в своей транзакции; ошибка одного не мешает остальным. */
export async function runScheduler(db: Db, today: string, horizonDays: number, log: Logger): Promise<SchedulerSummary> {
  const limit = addDays(today, horizonDays);
  const regs = await db
    .selectFrom('maintenance_regulation')
    .select('id')
    .where('status', '=', 'active')
    .where('next_due_date', '<=', limit)
    .orderBy('id')
    .execute();

  const summary: SchedulerSummary = { today, regulations: regs.length, created: [], failed: [] };
  for (const { id } of regs) {
    try {
      const created = await db.transaction().execute((trx) => generateForRegulation(trx, id, today, horizonDays));
      summary.created.push(...created);
      if (created.length > 0) log.info({ regulation_id: id, tasks: created.map((t) => t.task_number) }, 'задания созданы');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.failed.push({ regulation_id: id, error: message });
      log.error({ regulation_id: id, err: message }, 'ошибка генерации заданий');
    }
  }
  return summary;
}
