// Общие схемы zod для тел и параметров запросов.
import { z } from 'zod';
import { isIsoDate } from '../lib/dates.js';
import { SYSTEM_TYPES, TASK_STATUSES } from '../lib/labels.js';

export const idParam = z.object({ id: z.coerce.number().int().positive() });

export const version = z.number({ error: 'Укажите версию записи' }).int().positive();

export const isoDate = z.string({ error: 'Укажите дату' }).refine(isIsoDate, 'Дата в формате ГГГГ-ММ-ДД');

/** Обязательная строка: обрезается, не пустая, с ограничением длины. */
export const requiredText = (max: number, emptyMessage = 'Обязательное поле') =>
  z
    .string({ error: emptyMessage })
    .trim()
    .min(1, emptyMessage)
    .max(max, `Не длиннее ${max} символов`);

/** Необязательная строка: пустая строка превращается в null. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Не длиннее ${max} символов`)
    .nullish()
    .transform((v) => (v ? v : null));

export const optionalDate = z
  .union([isoDate, z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

export const systemType = z.enum(SYSTEM_TYPES as [string, ...string[]], { error: 'Неизвестный тип системы' });
export const taskStatus = z.enum(TASK_STATUSES as [string, ...string[]], { error: 'Неизвестный статус' });

export const boolQuery = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));

export const optionalId = z.coerce.number().int().positive().optional();

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

export function pageResult<T>(items: T[], total: number, page: number, pageSize: number) {
  return { items, total, page, page_size: pageSize };
}

export const LIMITS = { login: 150, name: 255, address: 500, phone: 32, text: 2000 } as const;
