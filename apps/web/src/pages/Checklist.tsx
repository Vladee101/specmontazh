// UC 14: выполнение ТО инженером. Черновик — явной кнопкой; отправка — после заполнения
// обязательных пунктов и фактической даты. Сервер проверяет всё повторно.
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { fmtDate, fmtMoment, todayMsk } from '../format';
import { COMMENT_HINTS, RESULT_COLORS, RESULT_LABELS, SYSTEM_TYPE_LABELS, type CheckResult } from '../labels';
import type { TaskDetail } from '../types';
import { Badge, Details, ErrorBox, Heading, Loading, Shell, StatusBadge, useLoad, useToast } from '../ui';
import { DateInput } from '../DateInput';

type Draft = Record<number, { result: CheckResult | ''; comment: string }>;

const RESULTS = Object.keys(RESULT_LABELS) as CheckResult[];

function draftOf(task: TaskDetail): Draft {
  return Object.fromEntries(task.checks.map((c) => [c.id, { result: c.result ?? '', comment: c.comment ?? '' }]));
}

export function Checklist() {
  const id = Number(useParams().id);
  const toast = useToast();
  const { data: task, error, setData } = useLoad(() => api.get<TaskDetail>(`/tasks/${id}`), [id]);
  const [draft, setDraft] = useState<Draft>({});
  const [comment, setComment] = useState('');
  const [actual, setActual] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);

  const load = (t: TaskDetail) => {
    setData(t);
    setDraft(draftOf(t));
    setComment(t.engineer_comment ?? '');
    setDirty(false);
  };
  useEffect(() => {
    if (task && Object.keys(draft).length === 0) {
      setDraft(draftOf(task));
      setComment(task.engineer_comment ?? '');
    }
  }, [task]); // eslint-disable-line react-hooks/exhaustive-deps

  // предупреждение при уходе со страницы с несохранёнными изменениями
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const editable = task?.status === 'in_progress' || task?.status === 'rework';
  const today = todayMsk();
  const created = task ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(task.created_at)) : '';

  const state = useMemo(() => {
    if (!task) return null;
    const filled = task.checks.filter((c) => draft[c.id]?.result).length;
    const missingRequired = task.checks.filter((c) => c.is_required && !draft[c.id]?.result);
    const missingComment = task.checks.filter((c) => {
      const d = draft[c.id];
      return d?.result && d.result !== 'passed' && !d.comment.trim();
    });
    const partial = task.checks.some((c) => c.is_required && draft[c.id]?.result === 'not_checked');
    const dateOk = !!actual && actual <= today && actual >= created;
    return { filled, missingRequired, missingComment, partial, dateOk };
  }, [task, draft, actual, today, created]);

  if (error) return <Shell section="Мои задания"><ErrorBox error={error} /></Shell>;
  if (!task || !state) return <Shell section="Мои задания"><Loading /></Shell>;

  const setCheck = (checkId: number, patch: Partial<Draft[number]>) => {
    setDraft((d) => ({ ...d, [checkId]: { ...d[checkId]!, ...patch } }));
    setDirty(true);
  };

  // Отправляются все пункты по порядку: индексы ошибок checks[i] совпадают с порядком на экране.
  // Сервер записывает автора и время только у изменённых.
  const allChecks = () => task.checks.map((c) => ({ id: c.id, result: draft[c.id]?.result || null, comment: draft[c.id]?.comment.trim() || null }));

  const handle = async (fn: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    setFieldErrors({});
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError) {
        setFieldErrors(e.fieldErrors);
        setProblem(e.code === 'version_conflict' ? 'Задание изменено руководителем. Обновите страницу: несохранённые изменения будут потеряны.' : e.message);
      } else setProblem(String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const saved = await api.put<TaskDetail>(`/tasks/${task.id}/checks`, { version: task.version, checks: allChecks(), engineer_comment: comment.trim() || null });
    load(saved);
    return saved;
  };

  const start = () =>
    handle(async () => {
      load(await api.post<TaskDetail>(`/tasks/${task.id}/start`, { version: task.version }));
      toast('Работа начата');
    });

  const saveDraft = () =>
    handle(async () => {
      await save();
      toast('Черновик сохранён');
    });

  const submit = () =>
    handle(async () => {
      const saved = dirty ? await save() : task;
      const sent = await api.post<TaskDetail>(`/tasks/${task.id}/submit`, { version: saved.version, actual_performed_on: actual, engineer_comment: comment.trim() || null });
      load(sent);
      toast(sent.is_partial ? 'Частичный результат передан руководителю на проверку' : 'Результат передан руководителю на проверку');
    });

  const canSubmit = editable && state.missingRequired.length === 0 && state.missingComment.length === 0 && state.dateOk && !busy;

  return (
    <Shell section="Мои задания">
      <Link className="sm-link" to="/my-tasks">
        ← Мои задания
      </Link>
      <div className="sm-gap" />
      <Heading title={`${task.task_number} · ${SYSTEM_TYPE_LABELS[task.system_type]}`} sub={`${task.object_name} / ${task.address}`} actions={<StatusBadge status={task.status} overdue={task.is_overdue} />} />

      {task.status === 'rework' && (
        <div className="sm-warning" style={{ marginBottom: 18 }}>
          <b>Возвращено руководителем{task.reviewed_by_name ? ` (${task.reviewed_by_name})` : ''}:</b> {task.review_comment}
        </div>
      )}
      {task.status === 'in_review' && <div className="sm-context" style={{ marginBottom: 18 }}>Результат на проверке у руководителя. Изменить его можно только после возврата на доработку.</div>}
      {task.status === 'accepted' && <div className="sm-context" style={{ marginBottom: 18 }}>ТО принято {fmtMoment(task.accepted_at)}.</div>}
      {task.status === 'cancelled' && <div className="sm-warning" style={{ marginBottom: 18 }}>Задание отменено: {task.cancellation_reason}</div>}

      <div className="sm-panel sm-pad" style={{ marginBottom: 18 }}>
        <Details
          items={[
            ['Исходный срок', fmtDate(task.original_due_date)],
            ['Текущий срок', `${fmtDate(task.current_due_date)}${task.is_overdue ? ' · срок истёк' : ''}`],
            ['Система', task.system_name],
            ['Начало работы', task.started_at ? fmtMoment(task.started_at) : '—'],
            ['Оборудование', task.equipment.map((e) => e.name).join(', ') || '—'],
          ]}
        />
      </div>

      {task.status === 'assigned' && (
        <div className="sm-panel sm-pad sm-bottom" style={{ marginBottom: 18, marginTop: 0 }}>
          <span>Чтобы заполнять чек-лист, начните работу.</span>
          <button className="sm-primary" onClick={start} disabled={busy}>
            Начать ТО
          </button>
        </div>
      )}

      <div className="sm-panel">
        <div className="sm-section-head">
          <h2>Чек-лист обслуживания</h2>
          <span className="sm-muted sm-small" aria-live="polite">
            Заполнено {state.filled} из {task.checks.length}
          </span>
        </div>
        {task.checks.map((c, i) => {
          const d = draft[c.id] ?? { result: '', comment: '' };
          const err = fieldErrors[`checks[${i}].comment`];
          const needComment = d.result && d.result !== 'passed';
          return (
            <div className={`sm-check ${err ? 'sm-check-error' : ''}`} key={c.id}>
              <div>
                <h3>
                  <span className="sm-num">{c.position}</span>
                  {c.check_text}
                </h3>
                <p>
                  {c.equipment_name ? `${c.equipment_name}${c.equipment_location ? ` · ${c.equipment_location}` : ''}` : 'Вся система'}
                  {c.is_required ? ' · обязательная проверка' : ' · необязательная'}
                </p>
              </div>
              {editable ? (
                <select aria-label={`Результат проверки ${c.position}`} value={d.result} onChange={(e) => setCheck(c.id, { result: e.target.value as CheckResult | '' })}>
                  <option value="">Выбрать результат</option>
                  {RESULTS.map((r) => (
                    <option key={r} value={r}>
                      {RESULT_LABELS[r]}
                    </option>
                  ))}
                </select>
              ) : (
                <div>{c.result ? <Badge color={RESULT_COLORS[c.result]}>{RESULT_LABELS[c.result]}</Badge> : <Badge>Не заполнено</Badge>}</div>
              )}
              {editable && (needComment || d.comment) ? (
                <textarea
                  aria-label={`Комментарий к проверке ${c.position}`}
                  className={err || (needComment && !d.comment.trim()) ? 'sm-invalid' : ''}
                  placeholder={d.result ? COMMENT_HINTS[d.result] : 'Комментарий'}
                  value={d.comment}
                  onChange={(e) => setCheck(c.id, { comment: e.target.value })}
                />
              ) : (
                !editable && c.comment && <p style={{ gridColumn: '1/-1', color: 'var(--sm-ink)', fontSize: 13 }}>{c.comment}</p>
              )}
              {err && <span className="sm-field-error">{err}</span>}
            </div>
          );
        })}
      </div>

      {(editable || task.engineer_comment) && (
        <div className="sm-panel sm-pad" style={{ marginTop: 18 }}>
          <label>
            Общий комментарий
            <textarea
              disabled={!editable}
              placeholder="Итоги работ и дополнительные замечания"
              value={comment}
              onChange={(e) => {
                setComment(e.target.value);
                setDirty(true);
              }}
            />
          </label>
        </div>
      )}

      {editable && (
        <>
          <div className="sm-panel sm-pad" style={{ marginTop: 18 }}>
            <label>
              Фактическая дата выполнения
              <DateInput min={created} max={today} value={actual} onChange={setActual} className={actual && !state.dateOk ? 'sm-invalid' : ''} />
            </label>
            <p className="sm-small" style={{ marginTop: 6, color: (actual && !state.dateOk) || fieldErrors.actual_performed_on ? 'var(--sm-red)' : 'var(--sm-muted)' }}>
              {fieldErrors.actual_performed_on ?? (actual && !state.dateOk ? 'Дата в будущем или раньше создания задания: отправка запрещена.' : `Не в будущем и не раньше создания задания (${fmtDate(created)}).`)}
            </p>
          </div>
          {state.partial && (
            <div className="sm-warning" style={{ marginTop: 14 }}>
              Обязательный пункт отмечен «Не проверено»: результат уйдёт на проверку как частичный. Принять частичное ТО руководитель не сможет, поэтому
              вернёт задание или отменит его.
            </div>
          )}
          {problem && (
            <div className="sm-error" role="alert" style={{ marginTop: 14 }}>
              {problem}
            </div>
          )}
          <div className="sm-bottom">
            <span className="sm-muted sm-small">
              {dirty ? 'Есть несохранённые изменения' : 'Черновик сохраняется по кнопке'}
              {state.missingRequired.length > 0 && ` · не заполнено обязательных: ${state.missingRequired.length}`}
            </span>
            <div className="sm-actions">
              <button onClick={saveDraft} disabled={busy || !dirty}>
                Сохранить черновик
              </button>
              <button className="sm-primary" onClick={submit} disabled={!canSubmit}>
                Отправить на проверку
              </button>
            </div>
          </div>
        </>
      )}
      {!editable && problem && <ErrorBox error={problem} />}
    </Shell>
  );
}
