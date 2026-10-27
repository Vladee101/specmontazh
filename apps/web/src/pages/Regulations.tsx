// UC 10: регламенты — создание, правка, активация, пауза, возобновление.
import { useState } from 'react';
import { api, qs, type Page } from '../api';
import { addDays, fmtDate, todayMsk } from '../format';
import { intervalLabel, REG_STATUS_LABELS, SYSTEM_TYPE_LABELS, SYSTEM_TYPES, systemTitle } from '../labels';
import type { LcSystem, Regulation, ServiceObject } from '../types';
import { Badge, ErrorBox, Field, Heading, Loading, Modal, Shell, Table, useFieldErrors, useFormState, useLoad, useToast } from '../ui';

type Dialog = { kind: 'new' } | { kind: 'edit' | 'activate' | 'resume' | 'pause'; reg: Regulation } | null;

export function Regulations() {
  const toast = useToast();
  const [filter, setFilter] = useState({ q: '', system_type: '', status: '' });
  const { data, error, loading, reload } = useLoad(() => api.get<{ items: Regulation[] }>(`/regulations${qs(filter)}`), [filter.q, filter.system_type, filter.status]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = (message?: string) => {
    setDialog(null);
    if (message) toast(message);
    void reload();
  };

  return (
    <Shell section="Регламенты">
      <Heading
        title="Регламенты обслуживания"
        sub="Периодичность задаётся в месяцах; чек-лист подставляется по типу системы"
        actions={
          <button className="sm-primary" onClick={() => setDialog({ kind: 'new' })}>
            + Добавить регламент
          </button>
        }
      />
      <div className="sm-filters">
        <input placeholder="Поиск по объекту, системе или названию" aria-label="Поиск регламента" onKeyDown={(e) => e.key === 'Enter' && setFilter({ ...filter, q: e.currentTarget.value.trim() })} onBlur={(e) => setFilter({ ...filter, q: e.currentTarget.value.trim() })} />
        <select aria-label="Тип системы" value={filter.system_type} onChange={(e) => setFilter({ ...filter, system_type: e.target.value })}>
          <option value="">Все типы систем</option>
          {SYSTEM_TYPES.map((t) => (
            <option key={t} value={t}>
              {SYSTEM_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <select aria-label="Состояние" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
          <option value="">Все состояния</option>
          {Object.entries(REG_STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <ErrorBox error={error} />
      {loading && !data ? (
        <Loading />
      ) : (
        <Table headers={['Регламент / объект', 'Периодичность', 'Шаблон', 'Следующее ТО', 'Состояние', '']} empty="Регламентов пока нет">
          {data?.items.map((r) => (
            <tr key={r.id}>
              <td>
                <b>{r.name}</b>
                <small>
                  {r.object_name} · {r.system_name}
                </small>
              </td>
              <td>{intervalLabel(r.interval_value)}</td>
              <td>{r.template_name}</td>
              <td>
                {r.status === 'paused' ? '—' : fmtDate(r.next_due_date)}
                {r.status === 'paused' && r.paused_at && <small>на паузе с {fmtDate(r.paused_at.slice(0, 10))}</small>}
              </td>
              <td>
                <Badge color={r.status === 'active' ? 'green' : ''}>{REG_STATUS_LABELS[r.status]}</Badge>
              </td>
              <td>
                {r.status === 'draft' && (
                  <>
                    <button className="sm-link" onClick={() => setDialog({ kind: 'activate', reg: r })}>
                      Активировать
                    </button>
                    {' · '}
                  </>
                )}
                {r.status === 'active' && (
                  <>
                    <button className="sm-link" onClick={() => setDialog({ kind: 'pause', reg: r })}>
                      Приостановить
                    </button>
                    {' · '}
                  </>
                )}
                {r.status === 'paused' && (
                  <>
                    <button className="sm-link" onClick={() => setDialog({ kind: 'resume', reg: r })}>
                      Возобновить
                    </button>
                    {' · '}
                  </>
                )}
                <button className="sm-link" onClick={() => setDialog({ kind: 'edit', reg: r })}>
                  Изменить
                </button>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <p className="sm-muted sm-small" style={{ marginTop: 17 }}>
        Изменение шаблона не меняет уже созданные задания. На паузе задания не создаются и не накапливаются. Если регламент активируется позже, чем за 5 дней
        до срока, задание создаётся сразу.
      </p>

      {dialog?.kind === 'new' && <RegulationForm onClose={() => setDialog(null)} onSaved={() => close('Регламент создан (черновик)')} />}
      {dialog?.kind === 'edit' && <RegulationForm reg={dialog.reg} onClose={() => setDialog(null)} onSaved={() => close('Регламент сохранён')} />}
      {dialog?.kind === 'activate' && <ActivateDialog reg={dialog.reg} onClose={() => setDialog(null)} onDone={close} />}
      {dialog?.kind === 'resume' && <ResumeDialog reg={dialog.reg} onClose={() => setDialog(null)} onDone={close} />}
      {dialog?.kind === 'pause' && (
        <Modal
          title={`Приостановить «${dialog.reg.name}»`}
          submitLabel="Приостановить"
          onClose={() => setDialog(null)}
          onSubmit={async () => {
            await api.post(`/regulations/${dialog.reg.id}/pause`, { version: dialog.reg.version });
            close('Регламент приостановлен');
          }}
        >
          <p>На паузе задания не создаются и не накапливаются. При возобновлении нужно задать новую ближайшую дату.</p>
        </Modal>
      )}
    </Shell>
  );
}

function RegulationForm({ reg, onClose, onSaved }: { reg?: Regulation; onClose(): void; onSaved(): void }) {
  const isDraft = !reg || reg.status === 'draft';
  const [v, set] = useFormState({
    object_id: reg ? String(reg.object_id) : '',
    system_id: reg ? String(reg.system_id) : '',
    name: reg?.name ?? '',
    interval_value: reg ? String(reg.interval_value) : '1',
    first_due_date: reg?.next_due_date ?? '',
  });
  const objects = useLoad(() => api.get<Page<ServiceObject>>('/objects?page_size=200'), []);
  const systems = useLoad(async () => (v.object_id ? (await api.get<{ items: LcSystem[] }>(`/systems${qs({ object_id: v.object_id, archived: false })}`)).items : []), [v.object_id]);
  const e = useFieldErrors();

  return (
    <Modal
      title={reg ? `Регламент «${reg.name}»` : 'Новый регламент'}
      onClose={onClose}
      onSubmit={() =>
        e.run(async () => {
          const interval = Number(v.interval_value);
          if (reg) {
            await api.patch(`/regulations/${reg.id}`, {
              version: reg.version,
              name: v.name,
              ...(reg.status !== 'active' ? { interval_value: interval } : {}),
              ...(isDraft && v.first_due_date !== reg.next_due_date ? { first_due_date: v.first_due_date } : {}),
            });
          } else {
            await api.post('/regulations', { system_id: Number(v.system_id) || undefined, name: v.name, interval_value: interval, first_due_date: v.first_due_date });
          }
          onSaved();
        })
      }
    >
      {!reg && (
        <>
          <Field label="Объект" error={e.of('object_id')}>
            <select value={v.object_id} onChange={(x) => (set('object_id', x.target.value), set('system_id', ''))}>
              <option value="">Выберите объект</option>
              {objects.data?.items.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Система" error={e.of('system_id')}>
            <select value={v.system_id} onChange={(x) => set('system_id', x.target.value)} disabled={!v.object_id}>
              <option value="">Выберите систему</option>
              {systems.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {systemTitle(s.name, s.system_type)}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
      {reg && (
        <p className="sm-muted sm-small">
          {reg.object_name} · {reg.system_name} · шаблон «{reg.template_name}»
        </p>
      )}
      <Field label="Название" error={e.of('name')}>
        <input value={v.name} onChange={(x) => set('name', x.target.value)} placeholder="ТО видеонаблюдения" />
      </Field>
      <div className="sm-fieldgrid">
        <Field label="Ближайшая дата ТО" error={e.of('first_due_date')}>
          <input type="date" min={todayMsk()} value={v.first_due_date} disabled={!isDraft} onChange={(x) => set('first_due_date', x.target.value)} />
        </Field>
        <Field label="Периодичность, месяцев" error={e.of('interval_value')}>
          <input type="number" min={1} max={120} value={v.interval_value} disabled={reg?.status === 'active'} onChange={(x) => set('interval_value', x.target.value)} />
        </Field>
      </div>
      <p className="sm-muted sm-small">
        {reg?.status === 'active'
          ? 'График действующего регламента не меняется: приостановите регламент и задайте новую дату при возобновлении.'
          : 'Дата в прошлом и нулевая периодичность запрещены. Чек-лист берётся из шаблона типа системы. Месяцы считаются от опорной даты: 31 января → 28 февраля → 31 марта.'}
      </p>
    </Modal>
  );
}

interface CreatedTasks {
  created_tasks: { task_number: string }[];
}

function ActivateDialog({ reg, onClose, onDone }: { reg: Regulation; onClose(): void; onDone(message: string): void }) {
  const inWindow = reg.next_due_date <= addDays(todayMsk(), 5);
  return (
    <Modal
      title="Активировать регламент"
      submitLabel="Активировать"
      onClose={onClose}
      onSubmit={async () => {
        const r = await api.post<CreatedTasks>(`/regulations/${reg.id}/activate`, { version: reg.version });
        onDone(r.created_tasks.length ? `Регламент активирован, создано заданий: ${r.created_tasks.map((t) => t.task_number).join(', ')}` : 'Регламент активирован');
      }}
    >
      <p>
        Ближайшая дата {fmtDate(reg.next_due_date)}
        {inWindow ? ' попадает в 5-дневное окно: задание будет создано сразу после активации.' : ': задание будет создано за 5 дней до неё.'} Исторические
        задания не создаются.
      </p>
    </Modal>
  );
}

function ResumeDialog({ reg, onClose, onDone }: { reg: Regulation; onClose(): void; onDone(message: string): void }) {
  const [date, setDate] = useState('');
  const e = useFieldErrors();
  return (
    <Modal
      title="Возобновить регламент"
      submitLabel="Возобновить"
      onClose={onClose}
      onSubmit={() =>
        e.run(async () => {
          const r = await api.post<CreatedTasks>(`/regulations/${reg.id}/resume`, { version: reg.version, next_due_date: date });
          onDone(r.created_tasks.length ? `Регламент возобновлён, создано заданий: ${r.created_tasks.length}` : 'Регламент возобновлён');
        })
      }
    >
      <Field label="Новая ближайшая дата ТО" error={e.of('next_due_date')}>
        <input type="date" min={todayMsk()} value={date} onChange={(x) => setDate(x.target.value)} />
      </Field>
      <p className="sm-muted sm-small">Период паузы не восполняется: задания за время паузы не создаются. Опорная дата сбрасывается на заданную.</p>
    </Modal>
  );
}
