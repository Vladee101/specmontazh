// Демонстрационные данные по макетам: руководитель, два инженера, четыре объекта
// с системами и оборудованием, действующие регламенты и задания на ближайшие дни.
// Запускается один раз на пустой базе (после seedTemplates).
import { sql } from 'kysely';
import type { Db } from './index.js';
import type { SystemType } from './types.js';
import { addDays, dateIn } from '../lib/dates.js';
import { hashPassword } from '../lib/password.js';
import { generateForRegulation } from '../services/generation.js';

type Eq = [name: string, type: string, location: string];

const OBJECTS: {
  name: string;
  customer: string;
  address: string;
  contact: [string, string];
  notes?: string;
  systems: { name: string; type: SystemType; equipment: Eq[]; interval: number; dueInDays: number }[];
}[] = [
  {
    name: 'БЦ «Северный»',
    customer: 'ООО «Север»',
    address: 'ул. Центральная, 18',
    contact: ['Ирина Волкова', '+7 (900) 000-00-01'],
    notes: 'Вход со двора, пропуск на посту',
    systems: [
      {
        name: 'Видеонаблюдение', type: 'video_surveillance', interval: 1, dueInDays: 0,
        equipment: [['Камера К-01', 'Камера', 'Главный вход'], ['Камера К-02', 'Камера', 'Парковка'], ['Видеорегистратор ВР-01', 'Видеорегистратор', 'Пост охраны']],
      },
      {
        name: 'СОУЭ', type: 'evacuation_alert', interval: 3, dueInDays: 2,
        equipment: [['Оповещатель ОП-01', 'Оповещатель', 'Коридор, 1 этаж'], ['Оповещатель ОП-02', 'Оповещатель', 'Коридор, 2 этаж'], ['Усилитель УС-01', 'Усилитель', 'Серверная']],
      },
    ],
  },
  {
    name: 'Школа № 12',
    customer: 'МБОУ СОШ № 12',
    address: 'ул. Школьная, 7',
    contact: ['Олег Иванов', '+7 (900) 000-00-02'],
    systems: [
      {
        name: 'Пожарная сигнализация', type: 'fire_alarm', interval: 3, dueInDays: 1,
        equipment: [['Прибор ПКП-01', 'Приёмно-контрольный прибор', 'Вахта'], ['Извещатель ИП-01', 'Извещатель', 'Актовый зал'], ['Извещатель ИП-02', 'Извещатель', 'Столовая']],
      },
    ],
  },
  {
    name: 'Склад «Вектор»',
    customer: 'ООО «Вектор»',
    address: 'Промышленный проезд, 4',
    contact: ['Анна Белова', '+7 (900) 000-00-03'],
    systems: [
      {
        name: 'Охранная сигнализация', type: 'security_alarm', interval: 6, dueInDays: 3,
        equipment: [['Прибор ПКП-02', 'Приёмно-контрольный прибор', 'Пост охраны'], ['Извещатель ИО-01', 'Извещатель', 'Ворота'], ['Извещатель ИО-03', 'Извещатель', 'Зона погрузки']],
      },
    ],
  },
  {
    name: 'Офис «Контур»',
    customer: 'ООО «Контур»',
    address: 'ул. Мира, 21',
    contact: ['Пётр Орлов', '+7 (900) 000-00-04'],
    systems: [
      {
        name: 'Видеонаблюдение', type: 'video_surveillance', interval: 1, dueInDays: 4,
        equipment: [['Камера К-01', 'Камера', 'Ресепшен'], ['Видеорегистратор ВР-01', 'Видеорегистратор', 'Серверная']],
      },
    ],
  },
];

export async function seedDemo(db: Db, password: string, timeZone: string): Promise<string> {
  const hasObjects = await db.selectFrom('service_object').select('id').executeTakeFirst();
  if (hasObjects) return 'демо-данные не созданы: в базе уже есть объекты';

  const today = dateIn(timeZone, new Date());
  const hash = await hashPassword(password);
  return db.transaction().execute(async (trx) => {
    const users = await trx
      .insertInto('users')
      .values([
        { login: 'm.petrov', full_name: 'Михаил Петров', role: 'manager', password_hash: hash },
        { login: 'a.sokolov', full_name: 'Алексей Соколов', role: 'engineer', password_hash: hash },
        { login: 'd.orlov', full_name: 'Дмитрий Орлов', role: 'engineer', password_hash: hash },
      ])
      .onConflict((oc) => oc.expression(sql`lower(login)`).doNothing())
      .returning(['id', 'login'])
      .execute();
    const managerId = users.find((u) => u.login === 'm.petrov')?.id
      ?? (await trx.selectFrom('users').select('id').where('role', '=', 'manager').executeTakeFirstOrThrow()).id;

    let tasks = 0;
    for (const o of OBJECTS) {
      const obj = await trx
        .insertInto('service_object')
        .values({ created_by_id: managerId, name: o.name, customer_name: o.customer, address: o.address, contact_name: o.contact[0], contact_phone: o.contact[1], notes: o.notes ?? null })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const s of o.systems) {
        const sys = await trx.insertInto('low_current_system').values({ object_id: obj.id, name: s.name, system_type: s.type }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('equipment').values(s.equipment.map(([name, type, location]) => ({ system_id: sys.id, name, equipment_type: type, location }))).execute();
        const tpl = await trx.selectFrom('checklist_template').select('id').where('system_type', '=', s.type).executeTakeFirstOrThrow();
        const due = addDays(today, s.dueInDays);
        const reg = await trx
          .insertInto('maintenance_regulation')
          .values({
            system_id: sys.id, template_id: tpl.id, created_by_id: managerId, name: `ТО: ${s.name}`,
            interval_value: s.interval, schedule_anchor_date: due, next_due_date: due, status: 'active', activated_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        tasks += (await generateForRegulation(trx, reg.id, today, 5)).length;
      }
    }
    return `демо-данные созданы: пользователи m.petrov, a.sokolov, d.orlov (пароль из DEMO_PASSWORD), объектов ${OBJECTS.length}, заданий ${tasks}`;
  });
}
