// Начальное наполнение: четыре шаблона чек-листов и первый администратор.
// Повторный запуск безопасен: существующие шаблоны и пользователи не меняются.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './index.js';
import type { SystemType, TargetType } from './types.js';
import { hashPassword } from '../lib/password.js';

export const DEFAULT_SEED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../db/seed');

interface TemplateSeed {
  system_type: SystemType;
  name: string;
  items: { section_name: string | null; check_text: string; target_type: TargetType; equipment_type_filter: string[] | null; is_required: boolean }[];
}

export async function seedTemplates(db: Db, dir = DEFAULT_SEED_DIR): Promise<string[]> {
  const { templates } = JSON.parse(await readFile(resolve(dir, 'templates.json'), 'utf8')) as { templates: TemplateSeed[] };
  const created: string[] = [];
  await db.transaction().execute(async (trx) => {
    for (const t of templates) {
      const tpl = await trx
        .insertInto('checklist_template')
        .values({ name: t.name, system_type: t.system_type })
        .onConflict((oc) => oc.column('system_type').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!tpl) continue; // шаблон уже есть — его пункты правит руководитель, seed их не трогает
      await trx
        .insertInto('template_item')
        .values(
          t.items.map((item, i) => ({
            ...item,
            template_id: tpl.id,
            position: i + 1,
            equipment_type_filter: item.equipment_type_filter && JSON.stringify(item.equipment_type_filter),
          })),
        )
        .execute();
      created.push(t.system_type);
    }
  });
  return created;
}

/** Первый администратор создаётся, только если активного администратора ещё нет. */
export async function seedAdmin(db: Db, admin: { login?: string; password?: string; fullName: string }): Promise<'created' | 'exists' | 'skipped'> {
  const existing = await db.selectFrom('users').select('id').where('role', '=', 'admin').where('is_active', '=', true).executeTakeFirst();
  if (existing) return 'exists';
  if (!admin.login || !admin.password) return 'skipped';
  if (admin.password.length < 8) throw new Error('ADMIN_PASSWORD: не короче 8 символов');
  await db
    .insertInto('users')
    .values({ login: admin.login, full_name: admin.fullName, role: 'admin', password_hash: await hashPassword(admin.password) })
    .execute();
  return 'created';
}
