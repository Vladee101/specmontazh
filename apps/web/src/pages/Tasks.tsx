// UC 19: список заданий руководителя — вкладки, фильтры, пагинация.
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs, type Page } from '../api';
import { fmtDate } from '../format';
import { STATUS_LABELS, STATUSES, SYSTEM_TYPE_LABELS, SYSTEM_TYPES } from '../labels';
import type { Engineer, ServiceObject, TaskListItem } from '../types';
import { ErrorBox, Heading, Loading, Pager, Shell, StatusBadge, Table, Tabs, useLoad } from '../ui';
import { DateInput } from '../DateInput';

const VIEWS = [
  ['all', 'Все задания'],
  ['overdue', 'Просрочено'],
  ['in_review', 'На проверке'],
  ['cancelled', 'Отменённые'],
] as const;
type View = (typeof VIEWS)[number][0];
const PAGE_SIZE = 25;
const FILTER_KEYS = ['q', 'object_id', 'system_type', 'engineer_id', 'status', 'due_from', 'due_to'] as const;

export function Tasks() {
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as View) || 'all';
  const page = Number(params.get('page') || 1);
  const filter = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<(typeof FILTER_KEYS)[number], string>;

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const refs = useLoad(
    async () => {
      const [objects, engineers] = await Promise.all([
        api.get<Page<ServiceObject>>('/objects?page_size=200'),
        api.get<{ items: Engineer[] }>('/engineers?include_inactive=true'),
      ]);
      return { objects: objects.items, engineers: engineers.items };
    },
    [],
  );
  const list = useLoad(() => api.get<Page<TaskListItem>>(`/tasks${qs({ ...filter, view, page, page_size: PAGE_SIZE })}`), [params.toString()]);

  return (
    <Shell section="Задания">
      <Heading title="Задания на обслуживание" sub="Плановые работы и результаты ТО на объектах" />
      <Tabs items={VIEWS} value={view} onChange={(v) => set('view', v === 'all' ? '' : v)} />
      <div className="sm-filters">
        <input
          defaultValue={filter.q}
          placeholder="Поиск по объекту или номеру задания"
          aria-label="Поиск задания"
          onKeyDown={(e) => e.key === 'Enter' && set('q', e.currentTarget.value.trim())}
          onBlur={(e) => e.currentTarget.value.trim() !== filter.q && set('q', e.currentTarget.value.trim())}
        />
        <select aria-label="Объект" value={filter.object_id} onChange={(e) => set('object_id', e.target.value)}>
          <option value="">Все объекты</option>
          {refs.data?.objects.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <select aria-label="Тип системы" value={filter.system_type} onChange={(e) => set('system_type', e.target.value)}>
          <option value="">Все типы систем</option>
          {SYSTEM_TYPES.map((t) => (
            <option key={t} value={t}>
              {SYSTEM_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <select aria-label="Исполнитель" value={filter.engineer_id} onChange={(e) => set('engineer_id', e.target.value)}>
          <option value="">Все инженеры</option>
          {refs.data?.engineers.map((e) => (
            <option key={e.id} value={e.id}>
              {e.full_name}
              {e.is_active ? '' : ' (заблокирован)'}
            </option>
          ))}
        </select>
        <select aria-label="Статус" value={filter.status} onChange={(e) => set('status', e.target.value)}>
          <option value="">Все статусы</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <label className="sm-inline">
          Исходный срок с <DateInput value={filter.due_from} onChange={(d) => set('due_from', d)} />
        </label>
        <label className="sm-inline">
          по <DateInput value={filter.due_to} onChange={(d) => set('due_to', d)} />
        </label>
      </div>

      <ErrorBox error={list.error} />
      {list.loading && !list.data ? (
        <Loading />
      ) : (
        <Table
          headers={['Задание / объект', 'Система', 'Исходный срок', 'Текущий срок', 'Исполнитель', 'Статус', '']}
          empty="Заданий по выбранным условиям нет"
          footer={list.data && <Pager page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={(p) => set('page', String(p))} />}
        >
          {list.data?.items.map((t) => (
            <tr key={t.id}>
              <td>
                <b>{t.task_number}</b>
                <small>{t.object_name}</small>
              </td>
              <td>
                {SYSTEM_TYPE_LABELS[t.system_type]}
                {t.system_name !== SYSTEM_TYPE_LABELS[t.system_type] && <small>{t.system_name}</small>}
              </td>
              <td>{fmtDate(t.original_due_date)}</td>
              <td>
                <span style={t.is_overdue ? { color: 'var(--sm-red)' } : undefined}>{fmtDate(t.current_due_date)}</span>
                {t.is_overdue && <small>Срок истёк</small>}
                {t.original_due_date !== t.current_due_date && <small>перенесён</small>}
                {t.has_deadline_violation && !t.is_overdue && t.status !== 'cancelled' && <small>было нарушение срока</small>}
              </td>
              <td>{t.engineer_name ?? 'Не назначен'}</td>
              <td>
                <StatusBadge status={t.status} overdue={t.is_overdue} />
              </td>
              <td>
                <Link className="sm-link" to={`/tasks/${t.id}`}>
                  Открыть →
                </Link>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <p className="sm-muted sm-small" style={{ marginTop: 16 }}>
        Задания формируются автоматически за 5 дней до плановой даты ТО. «На проверке» в просрочку не входит; принятые и отменённые
        задания в текущие просрочки не попадают.
      </p>
    </Shell>
  );
}
