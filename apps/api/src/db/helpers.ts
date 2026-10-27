import { notFound, versionConflict } from '../http/errors.js';

/** Проверка оптимистичной блокировки: запись существует и её версия совпадает с присланной. */
export function assertVersion<T extends { version: number }>(row: T | undefined, expected: number, what?: string): T {
  if (!row) throw notFound(what ? `${what} не найден(а)` : undefined);
  if (row.version !== expected) throw versionConflict();
  return row;
}

export function requireRow<T>(row: T | undefined, message?: string): T {
  if (!row) throw notFound(message);
  return row;
}
