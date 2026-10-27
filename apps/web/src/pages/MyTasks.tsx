// Задания инженера: только свои, открытые сверху. Список рассчитан на ширину 360 px.
import { Link } from 'react-router-dom';
import { api, qs, type Page } from '../api';
import { useState } from 'react';
import { fmtDate } from '../format';
import { SYSTEM_TYPE_LABELS } from '../labels';
import type { TaskListItem } from '../types';
import { ErrorBox, Heading, Loading, Pager, Shell, StatusBadge, Tabs, useLoad } from '../ui';

const VIEWS = [
  ['open', 'Текущие'],
  ['all', 'Все'],
] as const;
const PAGE_SIZE = 20;

export function MyTasks() {
  const [view, setView] = useState<'open' | 'all'>('open');
  const [page, setPage] = useState(1);
  const { data, error, loading } = useLoad(() => api.get<Page<TaskListItem>>(`/tasks${qs({ view, page, page_size: PAGE_SIZE })}`), [view, page]);

  // ближайшие сроки — первыми
  const items = [...(data?.items ?? [])].sort((a, b) => a.current_due_date.localeCompare(b.current_due_date));

  return (
    <Shell section="Мои задания">
      <Heading title="Мои задания" sub="Назначенные вам работы по техническому обслуживанию" />
      <Tabs
        items={VIEWS}
        value={view}
        onChange={(v) => {
          setView(v);
          setPage(1);
        }}
      />
      <ErrorBox error={error} />
      {loading && !data ? (
        <Loading />
      ) : (
        <div className="sm-panel">
          {items.length === 0 && <div className="sm-empty">{view === 'open' ? 'Текущих заданий нет' : 'Заданий нет'}</div>}
          {items.map((t) => (
            <Link key={t.id} to={`/tasks/${t.id}`} className="sm-check" style={{ color: 'inherit', textDecoration: 'none' }}>
              <div>
                <h3>
                  {t.task_number} · {SYSTEM_TYPE_LABELS[t.system_type]}
                </h3>
                <p>
                  {t.object_name} · {t.address}
                </p>
                <p style={t.is_overdue ? { color: 'var(--sm-red)' } : undefined}>
                  Срок: {fmtDate(t.current_due_date)}
                  {t.is_overdue && ' · срок истёк'}
                </p>
              </div>
              <div>
                <StatusBadge status={t.status} overdue={t.is_overdue} />
              </div>
            </Link>
          ))}
          {data && data.total > PAGE_SIZE && <Pager page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} />}
        </div>
      )}
    </Shell>
  );
}
