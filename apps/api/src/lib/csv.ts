// CSV для Excel: UTF-8 с BOM, разделитель «;», строки через CRLF.
// Текст, начинающийся с = + - @ (а также табуляции и CR), получает префикс «'»,
// чтобы табличный редактор не выполнил его как формулу.

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[;"\r\n]/;

export type CsvValue = string | number | boolean | null | undefined;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && FORMULA_START.test(s)) s = `'${s}`;
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: readonly CsvValue[][]): string {
  const lines = [header.map(csvCell).join(';'), ...rows.map((r) => r.map(csvCell).join(';'))];
  return `﻿${lines.join('\r\n')}\r\n`;
}
