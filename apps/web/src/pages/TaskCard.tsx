// Карточка задания руководителя: UC 12 (исполнитель), 13 (перенос), 15 (приёмка, возврат),
// 19 (история), 21 (отмена).
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { fmtDate, fmtMoment, todayMsk } from '../format';
import { RESULT_COLORS, RESULT_LABELS, SYSTEM_TYPE_LABELS, OPEN_STATUSES } from '../labels';
import type { Engineer, TaskDetail } from '../types';
import { Badge, Details, ErrorBox, Field, Heading, Loading, Modal, Shell, StatusBadge, useFieldErrors, useLoad, useToast } from '../ui';
import { TaskHistory } from './TaskHistory';
import { DateInput } from '../DateInput';

type Dialog = 'assign' | 'reschedule' | 'cancel' | 'return' | 'accept' | null;

export function TaskCard() {
  const id = Number(useParams().id);
  const { data: task, error, reload, setData } = useLoad(() => api.get<TaskDetail>(`/tasks/${id}`), [id]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const toast = useToast();

  if (error) return <Shell section="Задания"><ErrorBox error={error} /></Shell>;
  if (!task) return <Shell section="Задания"><Loading /></Shell>;

  const done = (updated: TaskDetail, message: string) => {
    setData(updated);
    setDialog(null);
    toast(message);
  };
  const onConflict = async () => {
    await reload();
  };

  const isReview = task.status === 'in_review';
  const isOpen = OPEN_STATUSES.includes(task.status);
  const canAssign = isOpen;
  const blocking = task.checks.filter((c) => c.is_required && (c.result === null || c.result === 'not_checked'));
  const required = task.checks.filter((c) => c.is_required).length;

  return (
    <Shell section="Задания">
      <Link className="sm-link" to="/tasks">
        ← Задания
      </Link>
      <div className="sm-gap" />
      <Heading
        title={`${task.task_number} · ${SYSTEM_TYPE_LABELS[task.system_type]}`}
        sub={
          <>
            <Link className="sm-link" to={`/objects/${task.object_id}`}>{task.object_name}</Link> / {task.address} · {task.system_name}
          </>
        }
        actions={<StatusBadge status={task.status} overdue={task.is_overdue} />}
      />

      <div className="sm-grid">
        <div className="sm-panel sm-pad">
          <Details
            items={[
              ['Исполнитель', task.engineer_name ?? 'Не назначен'],
              ['Регламент', task.regulation_name],
              ['Исходный срок', fmtDate(task.original_due_date)],
              ['Текущий срок', `${fmtDate(task.current_due_date)}${task.original_due_date !== task.current_due_date ? ' (перенесён)' : ''}`],
              ['Фактическая дата', fmtDate(task.actual_performed_on)],
              ['Принято', task.accepted_at ? `${fmtMoment(task.accepted_at)} · ${task.reviewed_by_name ?? ''}` : '—'],
              ['Оборудование', task.equipment.map((e) => e.name).join(', ') || '—'],
              ['Нарушение срока', task.has_deadline_violation ? <Badge color="orange">Да</Badge> : 'Нет'],
            ]}
          />
        </div>
        <TaskHistory taskId={task.id} version={task.version} />
      </div>

      {task.status === 'rework' && (
        <div className="sm-warning" style={{ marginTop: 18 }}>
          <b>Возвращено на доработку.</b> {task.review_comment}
        </div>
      )}
      {task.status === 'cancelled' && (
        <div className="sm-warning" style={{ marginTop: 18 }}>
          <b>Отменено.</b> Причина: {task.cancellation_reason}. Отмена не считается выполнением; следующее ТО остаётся по графику.
        </div>
      )}
      {task.is_overdue && (
        <div className="sm-error" style={{ marginTop: 18 }}>
          <b>Срок истёк {fmtDate(task.current_due_date)}.</b> Задание в текущих просрочках. Перенос уже просроченного срока не стирает нарушение.
        </div>
      )}
      {isReview && task.is_partial && (
        <div className="sm-warning" style={{ marginTop: 18 }}>
          <b>Частичный результат.</b> Обязательный пункт «Не проверено»: принять ТО нельзя, верните на доработку или отмените.
        </div>
      )}

      {(canAssign || isReview) && (
        <div className="sm-panel sm-pad sm-bottom" style={{ marginTop: 20 }}>
          <div>
            <b>Исполнитель</b>
            <br />
            <span className="sm-muted sm-small">
              {task.engineer_name ?? 'Не назначен'}
              {task.status === 'created' && ' · при первом назначении статус станет «Назначено»'}
              {(task.status === 'in_progress' || task.status === 'rework') && ' · при замене результаты сохраняются, прежний инженер теряет доступ к изменению'}
              {isReview && ' · для задания «На проверке» сначала нужен возврат'}
            </span>
          </div>
          <button className="sm-primary" disabled={!canAssign} onClick={() => setDialog('assign')} title={isReview ? 'Сначала верните задание на доработку' : undefined}>
            {task.engineer_name ? 'Сменить исполнителя' : 'Назначить исполнителя'}
          </button>
        </div>
      )}

      {task.checks.length > 0 && task.status !== 'created' && task.status !== 'assigned' && (
        <div className="sm-panel" style={{ marginTop: 20 }}>
          <div className="sm-section-head">
            <h2>Результаты проверок</h2>
            <span className="sm-muted sm-small">
              {task.checks.length} пунктов, обязательных {required} · только для чтения
            </span>
          </div>
          {task.checks.map((c) => (
            <div className="sm-check" key={c.id}>
              <div>
                <h3>
                  <span className="sm-num">{c.position}</span>
                  {c.check_text}
                </h3>
                <p>
                  {c.equipment_name ? `${c.equipment_name}${c.equipment_location ? ` · ${c.equipment_location}` : ''}` : 'Вся система'}
                  {c.is_required ? ' · обязательная проверка' : ' · необязательная'}
                  {c.checked_by_name && ` · ${c.checked_by_name}, ${fmtMoment(c.checked_at)}`}
                </p>
              </div>
              <div>{c.result ? <Badge color={RESULT_COLORS[c.result]}>{RESULT_LABELS[c.result]}</Badge> : <Badge>Не заполнено</Badge>}</div>
              {c.comment && <p style={{ gridColumn: '1/-1', color: 'var(--sm-ink)', fontSize: 13 }}>{c.comment}</p>}
            </div>
          ))}
          {task.engineer_comment && (
            <div className="sm-check">
              <div style={{ gridColumn: '1/-1' }}>
                <h3>Общий комментарий инженера</h3>
                <p style={{ color: 'var(--sm-ink)', fontSize: 13 }}>{task.engineer_comment}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {(isOpen || isReview) && (
        <div className="sm-bottom">
          <div className="sm-actions">
            <button onClick={() => setDialog('reschedule')}>Перенести срок</button>
            <button onClick={() => setDialog('cancel')}>Отменить задание</button>
          </div>
          {isReview && (
            <div className="sm-actions">
              <button onClick={() => setDialog('return')}>На доработку</button>
              <button className="sm-primary" disabled={blocking.length > 0} onClick={() => setDialog('accept')} title={blocking.length ? 'Частичное ТО принять нельзя' : undefined}>
                Принять ТО
              </button>
            </div>
          )}
        </div>
      )}

      {dialog === 'assign' && <AssignDialog task={task} onClose={() => setDialog(null)} onDone={(t) => done(t, 'Исполнитель назначен')} onConflict={onConflict} />}
      {dialog === 'reschedule' && <RescheduleDialog task={task} onClose={() => setDialog(null)} onDone={(t) => done(t, 'Срок перенесён')} onConflict={onConflict} />}
      {dialog === 'cancel' && (
        <ReasonDialog
          task={task}
          title={`Отменить задание ${task.task_number}`}
          hint="Результаты и история сохранятся. Задание не считается выполненным и повторно не создаётся; следующее ТО остаётся по графику."
          label="Причина отмены"
          field="reason"
          path="cancel"
          submitLabel="Отменить задание"
          onClose={() => setDialog(null)}
          onDone={(t) => done(t, 'Задание отменено')}
          onConflict={onConflict}
        />
      )}
      {dialog === 'return' && (
        <ReasonDialog
          task={task}
          title="Вернуть на доработку"
          label="Что требуется исправить"
          field="comment"
          path="return"
          submitLabel="Вернуть"
          onClose={() => setDialog(null)}
          onDone={(t) => done(t, 'Задание возвращено на доработку')}
          onConflict={onConflict}
        />
      )}
      {dialog === 'accept' && (
        <Modal
          title={`Принять ТО ${task.task_number}`}
          submitLabel="Принять ТО"
          onClose={() => setDialog(null)}
          onSubmit={async () => {
            try {
              done(await api.post<TaskDetail>(`/tasks/${task.id}/accept`, { version: task.version }), 'Полное ТО принято');
            } catch (e) {
              await onConflict();
              throw e;
            }
          }}
        >
          <p>Все обязательные проверки заполнены. После приёмки результаты не меняются.</p>
          {task.checks.some((c) => c.result === 'deviation') && <p className="sm-muted sm-small" style={{ marginTop: 10 }}>Замечания о дефектах сохранятся в результатах и отчёте; приёмку они не блокируют.</p>}
        </Modal>
      )}
    </Shell>
  );
}

interface DialogProps {
  task: TaskDetail;
  onClose(): void;
  onDone(task: TaskDetail): void;
  onConflict(): Promise<void>;
}

/** Ошибка версии — карточку перечитываем, текст показываем в диалоге. */
async function withConflict<T>(fn: () => Promise<T>, onConflict: () => Promise<void>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { code?: string }).code === 'version_conflict') await onConflict();
    throw e;
  }
}

function AssignDialog({ task, onClose, onDone, onConflict }: DialogProps) {
  const { data } = useLoad(() => api.get<{ items: Engineer[] }>('/engineers'), []);
  const [engineerId, setEngineerId] = useState('');
  const errors = useFieldErrors();
  return (
    <Modal
      title={task.engineer_name ? 'Сменить исполнителя' : 'Назначить исполнителя'}
      submitLabel="Назначить"
      onClose={onClose}
      onSubmit={() =>
        errors.run(() =>
          withConflict(async () => onDone(await api.post<TaskDetail>(`/tasks/${task.id}/assign`, { version: task.version, engineer_id: Number(engineerId) || undefined })), onConflict),
        )
      }
    >
      <Field label="Инженер" error={errors.of('engineer_id')}>
        <select value={engineerId} onChange={(e) => setEngineerId(e.target.value)} required>
          <option value="">Выберите инженера</option>
          {data?.items
            .filter((e) => e.id !== task.assigned_engineer_id)
            .map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name} · незавершённых: {e.open_tasks_count}
              </option>
            ))}
        </select>
      </Field>
      <p className="sm-muted sm-small">Доступны только активные инженеры. Заблокированные в списке не показываются.</p>
    </Modal>
  );
}

function RescheduleDialog({ task, onClose, onDone, onConflict }: DialogProps) {
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const errors = useFieldErrors();
  return (
    <Modal
      title={`Перенести срок ${task.task_number}`}
      submitLabel="Перенести"
      onClose={onClose}
      onSubmit={() =>
        errors.run(() =>
          withConflict(async () => onDone(await api.post<TaskDetail>(`/tasks/${task.id}/reschedule`, { version: task.version, new_due_date: date, reason })), onConflict),
        )
      }
    >
      <p className="sm-muted sm-small">
        Исходная дата: {fmtDate(task.original_due_date)} · текущая: {fmtDate(task.current_due_date)}
      </p>
      <Field label="Новый срок" error={errors.of('new_due_date')}>
        <DateInput min={todayMsk()} value={date} onChange={setDate} />
      </Field>
      <Field label="Причина переноса" error={errors.of('reason')}>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Например, нет доступа к объекту" />
      </Field>
      <p className="sm-muted sm-small">
        Та же дата или пустая причина отклоняются. Исходный срок и даты следующих ТО не меняются. Перенос после истечения прежнего срока нарушение не
        стирает.
      </p>
    </Modal>
  );
}

function ReasonDialog({
  task,
  title,
  hint,
  label,
  field,
  path,
  submitLabel,
  onClose,
  onDone,
  onConflict,
}: DialogProps & { title: string; hint?: string; label: string; field: 'reason' | 'comment'; path: 'cancel' | 'return'; submitLabel: string }) {
  const [text, setText] = useState('');
  const errors = useFieldErrors();
  return (
    <Modal
      title={title}
      submitLabel={submitLabel}
      danger={path === 'cancel'}
      onClose={onClose}
      onSubmit={() => errors.run(() => withConflict(async () => onDone(await api.post<TaskDetail>(`/tasks/${task.id}/${path}`, { version: task.version, [field]: text })), onConflict))}
    >
      {hint && <p className="sm-muted sm-small">{hint}</p>}
      <Field label={label} error={errors.of(field)}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Обязательно" />
      </Field>
    </Modal>
  );
}
