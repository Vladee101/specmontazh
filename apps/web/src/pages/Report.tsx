// UC 20: отчёт за период по исходным плановым датам; таблица и CSV — одна выборка.
import { useState } from 'react';
import { api, qs, type Page } from '../api';
import { fmtDate, monthRange, todayMsk } from '../format';
import { STATUS_LABELS, STATUSES, SYSTEM_TYPE_LABELS, SYSTEM_TYPES, type SystemType, type TaskStatus } from '../labels';
import type { Engineer, ServiceObject } from '../types';
import { Badge, ErrorBox, Heading, Loading, Shell, StatusBadge, Table, useLoad } from '../ui';
import { DateInput } from '../DateInput';

interface ReportRow {
  id: number;
  task_number: string;
  status: TaskStatus;
  object_name: string;
  system_name: string;
  system_type: SystemType;
  engineer_name: string | null;
  original_due_date: string;
  current_due_date: string;
  is_overdue: boolean;
  has_deadline_violation: boolean;
  is_partial: boolean;
  remarks: string;
  review_comment: string | null;
  cancellation_reason: string | null;
}
interface ReportData {
  summary: { total: number; accepted: number; cancelled: number; not_completed: number };
  items: ReportRow[];
}

export function Report() {
  const [from, to] = monthRange(todayMsk());
  const [f, setF] = useState({ date_from: from, date_to: to, object_id: '', system_type: '', engineer_id: '', status: '' });
  const query = qs(f);
  const refs = useLoad(async () => {
    const [objects, engineers] = await Promise.all([api.get<Page<ServiceObject>>('/objects?page_size=200'), api.get<{ items: Engineer[] }>('/engineers?include_inactive=true')]);
    return { objects: objects.items, engineers: engineers.items };
  }, []);
  const report = useLoad(() => api.get<ReportData>(`/reports/maintenance${query}`), [query]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const rows = report.data?.items ?? [];
  const done = rows.filter((r) => r.status !== 'cancelled');
  const cancelled = rows.filter((r) => r.status === 'cancelled');
  const row = (t: ReportRow) => (
    <tr key={t.id} className={t.status === 'cancelled' ? 'sm-row-muted' : ''}>
      <td>
        <b>{t.task_number}</b>
        <small>{t.object_name}</small>
      </td>
      <td>{SYSTEM_TYPE_LABELS[t.system_type]}</td>
      <td>{t.engineer_name ?? '—'}</td>
      <td>
        <StatusBadge status={t.status} />
      </td>
      <td>{fmtDate(t.original_due_date)}</td>
      <td>{fmtDate(t.current_due_date)}</td>
      <td>{t.is_overdue ? <Badge color="red">Да</Badge> : 'Нет'}</td>
      <td>{t.has_deadline_violation ? <Badge color="orange">Да</Badge> : 'Нет'}</td>
      <td>{t.is_partial ? 'Да' : 'Нет'}</td>
      <td style={{ minWidth: 220 }}>{t.remarks || '—'}</td>
      <td style={{ minWidth: 160 }}>{t.cancellation_reason ? `Отмена: ${t.cancellation_reason}` : t.review_comment ? `Возврат: ${t.review_comment}` : '—'}</td>
    </tr>
  );

  return (
    <Shell section="Отчёт">
      <Heading
        title="Отчёт по обслуживанию"
        sub="Результаты ТО за период: таблица и CSV строятся по одной выборке"
        actions={
          <a className="sm-link" href={`/api/v1/reports/maintenance.csv${query}`} download>
            <button className="sm-primary" type="button" tabIndex={-1}>
              ↓ Выгрузить CSV
            </button>
          </a>
        }
      />
      <div className="sm-panel sm-pad" style={{ marginBottom: 22 }}>
        <div className="sm-fieldgrid">
          <label>
            Исходная плановая дата: с
            <DateInput value={f.date_from} onChange={(d) => setF({ ...f, date_from: d })} />
          </label>
          <label>
            по
            <DateInput value={f.date_to} onChange={(d) => setF({ ...f, date_to: d })} />
          </label>
          <label>
            Объект
            <select value={f.object_id} onChange={set('object_id')}>
              <option value="">Все объекты</option>
              {refs.data?.objects.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Тип системы
            <select value={f.system_type} onChange={set('system_type')}>
              <option value="">Все типы систем</option>
              {SYSTEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SYSTEM_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Текущий исполнитель
            <select value={f.engineer_id} onChange={set('engineer_id')}>
              <option value="">Все инженеры</option>
              {refs.data?.engineers.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.full_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Статус
            <select value={f.status} onChange={set('status')}>
              <option value="">Все статусы</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <ErrorBox error={report.error} />
      {report.data && (
        <div className="sm-context" style={{ marginBottom: 14 }}>
          Найдено: {report.data.summary.total} · принято: {report.data.summary.accepted} · в работе и на проверке: {report.data.summary.not_completed} · отменено
          (отдельно, выполнением не считается): {report.data.summary.cancelled}
        </div>
      )}
      {report.loading && !report.data ? (
        <Loading />
      ) : (
        <Table
          headers={['Задание / объект', 'Система', 'Исполнитель', 'Статус', 'Исходный срок', 'Текущий срок', 'Просрочено', 'Нарушение срока', 'Частично', 'Замечания', 'Возврат / отмена']}
          empty="За выбранный период заданий нет. CSV будет содержать только строку заголовков."
        >
          {done.map(row)}
          {cancelled.length > 0 && (
            <tr>
              <td colSpan={11} className="sm-group">
                Отменённые задания · не считаются выполненными
              </td>
            </tr>
          )}
          {cancelled.map(row)}
        </Table>
      )}
      <p className="sm-muted sm-small" style={{ marginTop: 16 }}>
        Задания отбираются по исходной плановой дате: перенесённое задание остаётся в своём периоде. Причина переноса видна в истории задания.
      </p>
    </Shell>
  );
}
