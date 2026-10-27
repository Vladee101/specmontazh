// Единый формат ошибок API: HTTP-код и тело { code, message, field_errors, details? }.
import type { FastifyError, FastifyInstance } from 'fastify';
import { z } from 'zod';

export type FieldErrors = Record<string, string>;

export class AppError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429,
    readonly code: string,
    message: string,
    readonly fieldErrors: FieldErrors = {},
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, fieldErrors: FieldErrors = {}, code = 'validation_error') =>
  new AppError(400, code, message, fieldErrors);
export const fieldError = (field: string, message: string) => badRequest(message, { [field]: message });
export const unauthorized = (message = 'Требуется вход в систему') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Недостаточно прав для операции') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Запись не найдена') => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, {}, details);
export const versionConflict = () =>
  conflict('version_conflict', 'Запись изменена другим пользователем. Обновите карточку и повторите действие.');

/** Путь поля в стиле checks[3].comment */
export function issuePath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((acc, part) => {
    if (typeof part === 'number') return `${acc}[${part}]`;
    return acc ? `${acc}.${String(part)}` : String(part);
  }, '');
}

export function fromZod(error: z.ZodError): AppError {
  const fieldErrors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issuePath(issue.path) || '_';
    fieldErrors[key] ??= issue.message;
  }
  return badRequest('Проверьте заполнение полей', fieldErrors);
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw fromZod(result.error);
  return result.data;
}

// Ошибки PostgreSQL: схема — источник истины, нарушение её правил отдаётся как 409
// с понятным текстом. Тексты триггеров уже на русском.
const CONSTRAINT_MESSAGES: Record<string, { status: 400 | 409; field?: string; message: string }> = {
  users_login_uq: { status: 400, field: 'login', message: 'Логин уже занят' },
  task_regulation_date_uq: { status: 409, message: 'Задание на эту дату по регламенту уже существует' },
  template_type_uq: { status: 409, message: 'Шаблон для этого типа системы уже существует' },
  titem_position_uq: { status: 409, message: 'Позиция пункта в шаблоне уже занята' },
  equipment_dates_ck: { status: 400, field: 'decommissioned_on', message: 'Дата вывода не может быть раньше даты установки' },
  reg_next_ck: { status: 400, field: 'next_due_date', message: 'Ближайшая дата не может быть раньше опорной' },
  titem_filter_ck: { status: 400, field: 'equipment_type_filter', message: 'Фильтр типов задаётся только для пунктов по оборудованию и не может быть пустым' },
  task_check_comment_ck: { status: 400, message: 'Для результата, кроме «Соответствует», нужен комментарий' },
  task_rework_ck: { status: 400, field: 'comment', message: 'Для возврата на доработку нужен комментарий' },
  task_cancel_ck: { status: 400, field: 'reason', message: 'Для отмены нужна причина' },
  task_accepted_ck: { status: 409, message: 'Частичный результат принять нельзя' },
  deadline_diff_ck: { status: 400, field: 'new_due_date', message: 'Новый срок совпадает с текущим' },
  assignment_diff_ck: { status: 409, message: 'Этот инженер уже назначен' },
};

interface PgError {
  code?: string;
  constraint?: string;
  table?: string;
  message: string;
}

function isPgError(err: unknown): err is PgError {
  return typeof err === 'object' && err !== null && 'code' in err && typeof (err as PgError).code === 'string'
    && /^[0-9A-Z]{5}$/.test((err as PgError).code!);
}

export function fromPg(err: PgError): AppError | null {
  const known = err.constraint ? CONSTRAINT_MESSAGES[err.constraint] : undefined;
  if (known) {
    return known.status === 400
      ? badRequest(known.message, known.field ? { [known.field]: known.message } : {}, 'constraint_violation')
      : conflict('constraint_violation', known.message);
  }
  switch (err.code) {
    case '23505':
      return conflict('duplicate', 'Такая запись уже существует');
    case '23503':
      return conflict(
        'has_dependencies',
        'Операция невозможна: запись связана с другими данными (история ТО, системы, оборудование). Используйте архив или вывод из эксплуатации.',
      );
    case '23514': // CHECK и исключения триггеров (ERRCODE 23514)
      return conflict('rule_violation', err.constraint ? `Нарушено правило данных: ${err.constraint}` : err.message);
    case '23502':
      return badRequest('Не заполнено обязательное поле');
    case '22P02':
    case '22007':
    case '22008':
    case '22003':
      return badRequest('Неверный формат значения');
    case '40001':
    case '40P01':
      return conflict('concurrent_update', 'Одновременное изменение. Повторите действие.');
    default:
      return null;
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ code: 'not_found', message: 'Ресурс не найден', field_errors: {} });
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    const fe = err as Partial<FastifyError>;
    let appErr: AppError | null = null;
    if (err instanceof AppError) appErr = err;
    else if (err instanceof z.ZodError) appErr = fromZod(err);
    else if (isPgError(err)) appErr = fromPg(err);
    else if (fe.statusCode === 429) appErr = new AppError(429, 'too_many_requests', 'Слишком много попыток. Повторите позже.');
    else if (fe.validation) appErr = badRequest(fe.message ?? 'Неверный запрос');
    else if (fe.statusCode && fe.statusCode < 500) appErr = new AppError(400, fe.code ?? 'bad_request', fe.message ?? 'Неверный запрос');

    if (!appErr) {
      req.log.error({ err }, 'необработанная ошибка');
      reply.status(500).send({ code: 'internal_error', message: 'Внутренняя ошибка сервера', field_errors: {} });
      return;
    }
    const body: Record<string, unknown> = { code: appErr.code, message: appErr.message, field_errors: appErr.fieldErrors };
    if (appErr.details !== undefined) body.details = appErr.details;
    reply.status(appErr.status).send(body);
  });
}
