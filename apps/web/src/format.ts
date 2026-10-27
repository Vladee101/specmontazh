const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const TZ = 'Europe/Moscow';

/** YYYY-MM-DD → ДД.ММ.ГГГГ */
export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
}

/** Момент времени → «22 октября, 10:00» по Москве */
export function fmtMoment(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const year = get('year');
  const thisYear = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, year: 'numeric' }).format(new Date());
  return `${Number(get('day'))} ${MONTHS[Number(get('month')) - 1]}${year !== thisYear ? ` ${year}` : ''}, ${get('hour')}:${get('minute')}`;
}

/** Сегодня по Москве, YYYY-MM-DD */
export function todayMsk(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Первый и последний день месяца даты. */
export function monthRange(date: string): [string, string] {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return [`${y}-${mm}-01`, `${y}-${mm}-${String(last).padStart(2, '0')}`];
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

export function count(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${n} ${word}`;
}
