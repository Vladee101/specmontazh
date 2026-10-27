// Общие компоненты интерфейса по макетам.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { NavLink } from 'react-router-dom';
import { ApiError, type FieldErrors } from './api';
import { useAuth, useUser } from './auth';
import { initials } from './format';
import { ROLE_LABELS, STATUS_COLORS, STATUS_LABELS, type TaskStatus } from './labels';

// ---------- Каркас ----------

const NAV = {
  admin: [['Пользователи', '/users']],
  manager: [
    ['Задания', '/tasks'],
    ['Объекты', '/objects'],
    ['Регламенты', '/regulations'],
    ['Шаблоны', '/templates'],
    ['Отчёт', '/report'],
  ],
  engineer: [['Мои задания', '/my-tasks']],
} as const;

export function Shell({ section, children }: { section: string; children: ReactNode }) {
  const user = useUser();
  const { logout } = useAuth();
  return (
    <div className="sm-shell">
      <aside className="sm-side">
        <div className="sm-brand">
          <span className="sm-monogram">СМ</span>
          <span>
            Спецмонтаж<small>Техническое обслуживание</small>
          </span>
        </div>
        <div className="sm-navlabel">РАБОЧАЯ ОБЛАСТЬ</div>
        <nav>
          {NAV[user.role].map(([label, to]) => (
            <NavLink key={to} to={to}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sm-side-bottom">
          ООО НПО «Спецмонтаж»
          <br />
          Контроль обслуживания · MVP
        </div>
      </aside>
      <div>
        <header className="sm-top">
          <span>
            {ROLE_LABELS[user.role]} / {section}
          </span>
          <div className="sm-actions">
            <div className="sm-person">
              <span className="sm-avatar">{initials(user.full_name)}</span>
              <div>
                {user.full_name}
                <small>{ROLE_LABELS[user.role]}</small>
              </div>
            </div>
            <button className="sm-link sm-small" onClick={() => void logout()}>
              Выйти
            </button>
          </div>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}

export function Heading({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="sm-heading">
      <div>
        <h1>{title}</h1>
        {sub && <p className="sm-muted sm-small">{sub}</p>}
      </div>
      {actions && <div className="sm-actions">{actions}</div>}
    </div>
  );
}

export function Badge({ children, color = '' }: { children: ReactNode; color?: '' | 'green' | 'orange' | 'red' }) {
  return <span className={`sm-badge ${color}`}>{children}</span>;
}

export function StatusBadge({ status, overdue }: { status: TaskStatus; overdue?: boolean }) {
  return (
    <>
      <Badge color={STATUS_COLORS[status]}>{STATUS_LABELS[status]}</Badge>
      {overdue && (
        <>
          {' '}
          <Badge color="red">Просрочено</Badge>
        </>
      )}
    </>
  );
}

export function Tabs<T extends string>({ items, value, onChange }: { items: readonly (readonly [T, ReactNode])[]; value: T; onChange(v: T): void }) {
  return (
    <div className="sm-tabs" role="tablist">
      {items.map(([key, label]) => (
        <button key={key} role="tab" aria-selected={key === value} className={key === value ? 'active' : ''} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage(p: number): void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="sm-pager">
      <span>Найдено: {total}</span>
      <span className="sm-actions">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Предыдущая страница">
          ←
        </button>
        Страница {page} из {pages}
        <button disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Следующая страница">
          →
        </button>
      </span>
    </div>
  );
}

export function Table({ headers, children, empty, footer }: { headers: ReactNode[]; children: ReactNode; empty?: ReactNode; footer?: ReactNode }) {
  const hasRows = Array.isArray(children) ? children.flat().filter(Boolean).length > 0 : Boolean(children);
  return (
    <div className="sm-panel">
      <div className="sm-tablewrap">
        <table>
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {hasRows ? (
              children
            ) : (
              <tr>
                <td colSpan={headers.length} className="sm-empty">
                  {empty ?? 'Нет записей'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}

export function Details({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <div className="sm-details">
      {items.map(([k, v], i) => (
        <dl key={i}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </dl>
      ))}
    </div>
  );
}

export function Loading() {
  return <div className="sm-loading">Загрузка…</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="sm-error">{error instanceof Error ? error.message : String(error)}</div>;
}

// ---------- Загрузка данных ----------

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const result = await load();
      if (my === seq.current) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (my === seq.current) setError(e);
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}

// ---------- Уведомления ----------

const ToastContext = createContext<(text: string, kind?: 'ok' | 'error') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'error'; id: number } | null>(null);
  const show = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => setToast({ text, kind, id: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'error' ? 7000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div className={`sm-toast ${toast.kind === 'error' ? 'error' : ''}`} role="status" onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

// ---------- Диалоги и формы ----------

export function Modal({
  title,
  onClose,
  onSubmit,
  submitLabel = 'Сохранить',
  danger,
  children,
}: {
  title: ReactNode;
  onClose(): void;
  /** Без onSubmit диалог только информационный. */
  onSubmit?: () => Promise<void>;
  submitLabel?: string;
  danger?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!onSubmit) return onClose();
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (err) {
      // ошибки полей показывает сама форма через FormErrors; общий текст — здесь
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} onCancel={(e) => (e.preventDefault(), onClose())} aria-labelledby="sm-dialog-title">
      <form onSubmit={submit} noValidate>
        <h2 id="sm-dialog-title">{title}</h2>
        {children}
        {error && <div className="sm-error" style={{ marginTop: 14 }}>{error}</div>}
        <div className="sm-dialog-actions">
          <button type="button" onClick={onClose}>
            {onSubmit ? 'Отмена' : 'Закрыть'}
          </button>
          {onSubmit && (
            <button type="submit" className={danger ? 'sm-primary sm-danger' : 'sm-primary'} disabled={busy}>
              {busy ? 'Сохранение…' : submitLabel}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}

/** Ошибки полей из ApiError: errors.of('name') */
export function useFieldErrors() {
  const [errors, setErrors] = useState<FieldErrors>({});
  /** Выполняет действие; ошибки полей раскладывает по полям и пробрасывает дальше. */
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setErrors({});
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      throw e;
    }
  }, []);
  return { errors, run, of: (field: string) => errors[field], setErrors };
}

export function Field({ label, error, children }: { label: ReactNode; error?: string; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
      {error && <span className="sm-field-error">{error}</span>}
    </label>
  );
}

/** Состояние формы: [значения, установить поле] */
export function useFormState<T extends Record<string, unknown>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => setValues((v) => ({ ...v, [key]: value })), []);
  return [values, set, setValues] as const;
}
