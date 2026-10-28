// Поле даты с календарём на русском. Встроенный календарь <input type="date">
// показывает месяцы на языке браузера, а не страницы, поэтому он заменён.
// Значение, как и у встроенного поля, — YYYY-MM-DD или пустая строка.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { addDays, fmtDate, todayMsk } from './format';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** ДД.ММ.ГГГГ → YYYY-MM-DD; null, если даты не существует. */
function parseRu(text: string): string | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

const monthOf = (iso: string) => iso.slice(0, 7);
/** Сдвиг на n месяцев с прижатием к последнему дню: 31.01 → 28.02. */
function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}

export function DateInput({
  value,
  onChange,
  min,
  max,
  disabled,
  className,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange(value: string): void;
  min?: string;
  max?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}) {
  const [text, setText] = useState(value ? fmtDate(value) : '');
  const [open, setOpen] = useState(false);
  // день под фокусом клавиатуры; его месяц и показывается
  const [cursor, setCursor] = useState(value || todayMsk());
  const wrap = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const focusGrid = useRef(false);

  useEffect(() => setText(value ? fmtDate(value) : ''), [value]);

  const allowed = (iso: string) => (!min || iso >= min) && (!max || iso <= max);

  const type = (next: string) => {
    setText(next);
    if (!next.trim()) return onChange('');
    const iso = parseRu(next);
    if (iso) onChange(iso);
  };

  const show = () => {
    setCursor(value || (max && todayMsk() > max ? max : min && todayMsk() < min ? min : todayMsk()));
    focusGrid.current = true;
    pop.current?.showPopover();
  };
  const pick = (iso: string) => {
    onChange(iso);
    pop.current?.hidePopover();
    wrap.current?.querySelector('input')?.focus();
  };

  // popover="auto" сам закрывается по Esc и щелчку снаружи; состояние берём из события
  useEffect(() => {
    const el = pop.current;
    if (!el) return;
    const onToggle = (e: Event) => setOpen((e as ToggleEvent).newState === 'open');
    el.addEventListener('toggle', onToggle);
    return () => el.removeEventListener('toggle', onToggle);
  }, []);

  // календарь в верхнем слое (поверх диалогов), позиция — под полем или над ним
  useLayoutEffect(() => {
    if (!open || !wrap.current || !pop.current) return;
    const place = () => {
      const r = wrap.current!.getBoundingClientRect();
      const p = pop.current!;
      const below = window.innerHeight - r.bottom >= p.offsetHeight + 8 || r.top < p.offsetHeight + 8;
      p.style.top = `${below ? r.bottom + 4 : r.top - p.offsetHeight - 4}px`;
      p.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - p.offsetWidth - 8))}px`;
    };
    place();
    const close = (e: Event) => {
      if (!pop.current?.contains(e.target as Node)) pop.current?.hidePopover();
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  useEffect(() => {
    if (open && focusGrid.current) grid.current?.querySelector<HTMLButtonElement>(`[data-date="${cursor}"]`)?.focus();
  }, [open, cursor]);

  const onGridKey = (e: KeyboardEvent) => {
    const step: Record<string, () => string> = {
      ArrowLeft: () => addDays(cursor, -1),
      ArrowRight: () => addDays(cursor, 1),
      ArrowUp: () => addDays(cursor, -7),
      ArrowDown: () => addDays(cursor, 7),
      PageUp: () => addMonths(cursor, -1),
      PageDown: () => addMonths(cursor, 1),
    };
    const next = step[e.key];
    if (!next) return;
    e.preventDefault();
    focusGrid.current = true;
    setCursor(next());
  };

  // сетка 6 × 7 с понедельника
  const first = `${monthOf(cursor)}-01`;
  const [y, m] = first.split('-').map(Number) as [number, number];
  const shift = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i - shift));
  const today = todayMsk();
  const turn = (n: number) => {
    focusGrid.current = false;
    setCursor(addMonths(cursor, n));
  };

  return (
    <span className="sm-date" ref={wrap}>
      <input
        type="text"
        inputMode="numeric"
        placeholder="ДД.ММ.ГГГГ"
        aria-label={ariaLabel}
        value={text}
        disabled={disabled}
        className={className}
        onChange={(e) => type(e.target.value)}
        onBlur={() => setText(value ? fmtDate(value) : '')}
        onKeyDown={(e) => e.key === 'ArrowDown' && e.altKey && (e.preventDefault(), show())}
      />
      <button type="button" className="sm-date-btn" disabled={disabled} aria-label="Открыть календарь" aria-expanded={open} onClick={() => (open ? pop.current?.hidePopover() : show())}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <rect x="1.5" y="3" width="13" height="11.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M1.5 6.5h13M5 1.5v3M11 1.5v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      {/* щелчок по календарю не должен передаваться в поле через <label> */}
      <div popover="auto" ref={pop} className="sm-cal" role="dialog" aria-label="Календарь" onClick={(e) => e.preventDefault()}>
        {open && (
          <>
            <div className="sm-cal-head">
              <button type="button" aria-label="Предыдущий месяц" onClick={() => turn(-1)}>
                ‹
              </button>
              <b aria-live="polite">
                {MONTHS[m - 1]} {y}
              </b>
              <button type="button" aria-label="Следующий месяц" onClick={() => turn(1)}>
                ›
              </button>
            </div>
            <div className="sm-cal-grid" ref={grid} role="grid" onKeyDown={onGridKey}>
              {WEEKDAYS.map((w, i) => (
                <span key={w} className={i > 4 ? 'sm-cal-wd sm-cal-weekend' : 'sm-cal-wd'}>
                  {w}
                </span>
              ))}
              {days.map((d) => {
                const cls = ['sm-cal-day'];
                if (monthOf(d) !== monthOf(cursor)) cls.push('sm-cal-out');
                if (d === today) cls.push('sm-cal-today');
                if (d === value) cls.push('sm-cal-sel');
                return (
                  <button
                    type="button"
                    key={d}
                    data-date={d}
                    className={cls.join(' ')}
                    disabled={!allowed(d)}
                    tabIndex={d === cursor ? 0 : -1}
                    aria-pressed={d === value}
                    aria-label={fmtDate(d)}
                    onClick={() => pick(d)}
                  >
                    {Number(d.slice(8))}
                  </button>
                );
              })}
            </div>
            <div className="sm-cal-foot">
              <button type="button" disabled={!allowed(today)} onClick={() => pick(today)}>
                Сегодня
              </button>
              {value && (
                <button type="button" onClick={() => pick('')}>
                  Очистить
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </span>
  );
}
