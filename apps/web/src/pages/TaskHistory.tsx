// История задания: статусы, назначения, переносы — с автором и временем.
import { api } from '../api';
import { fmtDate, fmtMoment } from '../format';
import { STATUS_LABELS } from '../labels';
import type { HistoryEvent } from '../types';
import { ErrorBox, useLoad } from '../ui';

const STATUS_TITLES: Partial<Record<string, string>> = {
  created: 'Создано планировщиком',
  assigned: 'Назначен исполнитель',
  in_progress: 'Начато',
  in_review: 'Отправлено на проверку',
  rework: 'Возвращено на доработку',
  accepted: 'Принято',
  cancelled: 'Отменено',
};

function describe(e: HistoryEvent): [string, string] {
  const by = (name: string | null) => `${fmtMoment(e.changed_at)} · ${name ?? 'система'}`;
  switch (e.kind) {
    case 'status': {
      let title = STATUS_TITLES[e.new_status] ?? STATUS_LABELS[e.new_status];
      if (e.new_status === 'in_review' && e.comment) title += ` (${e.comment.toLowerCase()})`;
      // «Назначено» дублирует запись о назначении — оставляем только её
      const extra = [
        e.actual_performed_on ? `фактическая дата ${fmtDate(e.actual_performed_on)}` : null,
        e.new_status === 'rework' && e.comment ? `комментарий: ${e.comment}` : null,
        e.new_status === 'cancelled' && e.comment ? `причина: ${e.comment}` : null,
      ].filter(Boolean);
      return [title, [by(e.changed_by_name), ...extra].join(' · ')];
    }
    case 'assignment':
      return [
        e.previous_engineer_name ? `Исполнитель заменён: ${e.previous_engineer_name} → ${e.new_engineer_name}` : `Назначен исполнитель: ${e.new_engineer_name}`,
        by(e.changed_by_name),
      ];
    case 'deadline':
      return [`Срок перенесён ${fmtDate(e.previous_due_date)} → ${fmtDate(e.new_due_date)}`, `${by(e.changed_by_name)} · причина: ${e.reason}`];
  }
}

export function TaskHistory({ taskId, version }: { taskId: number; version: number }) {
  const { data, error } = useLoad(() => api.get<{ items: HistoryEvent[] }>(`/tasks/${taskId}/history`), [taskId, version]);
  const events = (data?.items ?? []).filter((e) => !(e.kind === 'status' && e.new_status === 'assigned'));
  return (
    <div className="sm-panel sm-pad">
      <h2>История задания</h2>
      <ErrorBox error={error} />
      <div className="sm-timeline">
        {events.map((e) => {
          const [title, sub] = describe(e);
          return (
            <div className="sm-event" key={`${e.kind}-${e.id}`}>
              <b>{title}</b>
              <br />
              <span className="sm-muted">{sub}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
