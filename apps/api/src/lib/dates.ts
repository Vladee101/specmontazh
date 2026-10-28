// Календарные даты — строки YYYY-MM-DD. Сравнение строк этого формата
// совпадает с хронологическим, поэтому даты сравниваются как строки.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

function parts(date: string): [number, number, number] {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`неверная дата: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function format(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Создание Intl.DateTimeFormat дорогое (доли миллисекунды): в CSV на 10 000 строк
// это секунды. Форматтеры создаются один раз на часовой пояс.
const formatters = new Map<string, { date: Intl.DateTimeFormat; time: Intl.DateTimeFormat }>();
function formattersFor(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = {
      // en-CA даёт формат YYYY-MM-DD
      date: new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }),
      time: new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    };
    formatters.set(timeZone, f);
  }
  return f;
}

/** Календарная дата момента времени в часовом поясе tz (для Europe/Moscow — московский день). */
export function dateIn(timeZone: string, moment: Date): string {
  return formattersFor(timeZone).date.format(moment);
}

/** Дата и время момента в часовом поясе tz: YYYY-MM-DD HH:MM. */
export function dateTimeIn(timeZone: string, moment: Date): string {
  const f = formattersFor(timeZone);
  return `${f.date.format(moment)} ${f.time.format(moment)}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return format(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Прибавляет месяцы; день, которого нет в целевом месяце, сводится к последнему дню (31.01 + 1 → 28.02). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = parts(date);
  const total = y * 12 + (m - 1) + months;
  const ty = Math.floor(total / 12);
  const tm = (total % 12) + 1;
  return format(ty, tm, Math.min(d, daysInMonth(ty, tm)));
}

function monthIndex(date: string): number {
  const [y, m] = parts(date);
  return y * 12 + (m - 1);
}

/**
 * Следующая плановая дата после current по графику от опорной даты anchor:
 * anchor + k·interval месяцев. Считается всегда от опорной даты, поэтому
 * 31 января → 28 февраля → 31 марта, а не 28 марта.
 */
export function nextScheduledDate(anchor: string, current: string, intervalMonths: number): string {
  // Следующий шаг всегда попадает в более поздний месяц, чем current, поэтому next > current.
  const steps = Math.floor((monthIndex(current) - monthIndex(anchor)) / intervalMonths);
  return addMonths(anchor, (steps + 1) * intervalMonths);
}
