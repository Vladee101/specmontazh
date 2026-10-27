// UC 04–09: карточка объекта — системы, оборудование, история ТО; архив и удаление.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs, type Page } from '../api';
import { count, fmtDate } from '../format';
import { REG_STATUS_LABELS, SYSTEM_TYPE_LABELS, systemTitle } from '../labels';
import type { Equipment, LcSystem, Regulation, ServiceObject, TaskListItem } from '../types';
import { Badge, Details, ErrorBox, Heading, Loading, Shell, StatusBadge, Table, Tabs, useLoad, useToast } from '../ui';
import { ArchiveDialog, DecommissionDialog, EquipmentDialog, ObjectDialog, SystemDialog } from './catalogDialogs';

type ObjectWithSystems = ServiceObject & { systems: LcSystem[] };
type SystemDetail = LcSystem & { equipment: Equipment[]; regulations: Regulation[]; type_locked: boolean; object_archived: boolean };
type Tab = 'equipment' | 'systems' | 'history';

export function ObjectCard() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const toast = useToast();
  const obj = useLoad(() => api.get<ObjectWithSystems>(`/objects/${id}`), [id]);
  const [tab, setTab] = useState<Tab>('equipment');
  const [dialog, setDialog] = useState<null | 'edit' | 'archive' | 'system-new' | { system: LcSystem; mode: 'edit' | 'archive' }>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  if (obj.error) return <Shell section="Объекты"><ErrorBox error={obj.error} /></Shell>;
  if (!obj.data) return <Shell section="Объекты"><Loading /></Shell>;
  const o = obj.data;
  const empty = o.systems.length === 0;

  const remove = async () => {
    if (!confirm(`Удалить объект «${o.name}»?`)) return;
    try {
      await api.del(`/objects/${o.id}`);
      toast('Объект удалён');
      navigate('/objects');
    } catch (e) {
      setActionError(e);
    }
  };

  return (
    <Shell section="Объекты">
      <Link className="sm-link" to="/objects">
        ← Объекты
      </Link>
      <div className="sm-gap" />
      <Heading
        title={o.name}
        sub={o.is_archived ? `Карточка объекта · в архиве с ${fmtDate(o.archived_at?.slice(0, 10))}` : 'Карточка объекта'}
        actions={
          !o.is_archived && (
            <>
              <button onClick={() => setDialog('edit')}>Редактировать</button>
              <button onClick={() => setDialog('archive')}>Архивировать</button>
              <button disabled={!empty} title={empty ? undefined : 'Удаление возможно только для карточки без связанных данных'} onClick={remove}>
                Удалить
              </button>
            </>
          )
        }
      />
      <ErrorBox error={actionError} />
      <div className="sm-panel sm-pad" style={{ marginBottom: 24 }}>
        <Details
          items={[
            ['Заказчик', o.customer_name],
            ['Адрес', o.address],
            ['Контактное лицо', o.contact_name],
            ['Телефон', o.contact_phone],
            ['Примечание', o.notes],
          ]}
        />
      </div>
      <Tabs<Tab>
        items={[
          ['equipment', 'Оборудование'],
          ['systems', <>Системы<small>{o.systems.length}</small></>],
          ['history', 'История ТО'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'equipment' && <EquipmentTab object={o} />}
      {tab === 'systems' && (
        <>
          {!o.is_archived && (
            <div className="sm-actions" style={{ marginBottom: 12 }}>
              <button className="sm-primary" onClick={() => setDialog('system-new')}>
                + Добавить систему
              </button>
            </div>
          )}
          <Table headers={['Система', 'Тип', 'Оборудование', '']} empty="Систем пока нет">
            {o.systems.map((s) => (
              <tr key={s.id} className={s.is_archived ? 'sm-row-muted' : ''}>
                <td>
                  <b>{s.name}</b>
                  {s.location && <small>{s.location}</small>}
                </td>
                <td>{SYSTEM_TYPE_LABELS[s.system_type]}</td>
                <td>{count(s.equipment_count ?? 0, 'устройство', 'устройства', 'устройств')}</td>
                <td>
                  {s.is_archived ? (
                    <Badge>В архиве</Badge>
                  ) : (
                    <>
                      <button className="sm-link" onClick={() => setDialog({ system: s, mode: 'edit' })}>
                        Изменить
                      </button>
                      {' · '}
                      <button className="sm-link" onClick={() => setDialog({ system: s, mode: 'archive' })}>
                        Архивировать
                      </button>
                      {' · '}
                      <button
                        className="sm-link"
                        onClick={async () => {
                          if (!confirm(`Удалить систему «${s.name}»?`)) return;
                          try {
                            await api.del(`/systems/${s.id}`);
                            toast('Система удалена');
                            void obj.reload();
                          } catch (e) {
                            setActionError(e);
                          }
                        }}
                      >
                        Удалить
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </>
      )}
      {tab === 'history' && <HistoryTab objectId={o.id} />}

      {dialog === 'edit' && (
        <ObjectDialog
          object={o}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            toast('Объект сохранён');
            void obj.reload();
          }}
        />
      )}
      {dialog === 'archive' && (
        <ArchiveDialog
          title={`Архивировать объект «${o.name}»`}
          text="После архивирования регламенты объекта приостанавливаются, история остаётся."
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.post(`/objects/${o.id}/archive`, { version: o.version });
            setDialog(null);
            toast('Объект перенесён в архив');
            void obj.reload();
          }}
        />
      )}
      {dialog === 'system-new' && (
        <SystemDialog
          objectId={o.id}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            toast('Система добавлена');
            void obj.reload();
          }}
        />
      )}
      {dialog && typeof dialog === 'object' && dialog.mode === 'edit' && <SystemEdit system={dialog.system} onClose={() => setDialog(null)} onSaved={() => (setDialog(null), toast('Система сохранена'), void obj.reload())} />}
      {dialog && typeof dialog === 'object' && dialog.mode === 'archive' && (
        <ArchiveDialog
          title={`Архивировать систему «${dialog.system.name}»`}
          text="После архивирования регламенты системы приостанавливаются."
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.post(`/systems/${dialog.system.id}/archive`, { version: dialog.system.version });
            setDialog(null);
            toast('Система перенесена в архив');
            void obj.reload();
          }}
        />
      )}
    </Shell>
  );
}

function SystemEdit({ system, onClose, onSaved }: { system: LcSystem; onClose(): void; onSaved(): void }) {
  const { data } = useLoad(() => api.get<SystemDetail>(`/systems/${system.id}`), [system.id]);
  if (!data) return null;
  return <SystemDialog objectId={system.object_id} system={data} typeLocked={data.type_locked} onClose={onClose} onSaved={onSaved} />;
}

function EquipmentTab({ object }: { object: ObjectWithSystems }) {
  const toast = useToast();
  const systems = object.systems.filter((s) => !s.is_archived || object.is_archived);
  const [systemId, setSystemId] = useState<number | null>(systems[0]?.id ?? null);
  useEffect(() => {
    if (systemId === null && systems[0]) setSystemId(systems[0].id);
  }, [systems, systemId]);
  const sys = useLoad(async () => (systemId ? api.get<SystemDetail>(`/systems/${systemId}`) : null), [systemId]);
  const [dialog, setDialog] = useState<null | 'new' | { eq: Equipment; mode: 'edit' | 'decommission' }>(null);
  const [error, setError] = useState<unknown>(null);

  if (systems.length === 0) return <div className="sm-context">Сначала добавьте систему на вкладке «Системы».</div>;
  const reload = () => void sys.reload();
  const archived = sys.data?.is_archived || object.is_archived;

  return (
    <>
      <div className="sm-filters">
        <select aria-label="Система" value={systemId ?? ''} onChange={(e) => setSystemId(Number(e.target.value))}>
          {systems.map((s) => (
            <option key={s.id} value={s.id}>
              {systemTitle(s.name, s.system_type)}
            </option>
          ))}
        </select>
        {!archived && (
          <button className="sm-primary" onClick={() => setDialog('new')}>
            + Добавить оборудование
          </button>
        )}
      </div>
      <ErrorBox error={error ?? sys.error} />
      {sys.data && (
        <Table headers={['Оборудование', 'Тип · модель · серийный №', 'Расположение', 'Состояние', '']} empty="Оборудования пока нет">
          {sys.data.equipment.map((e) => (
            <tr key={e.id}>
              <td>
                <b>{e.name}</b>
                <small>{sys.data!.name}</small>
              </td>
              <td>
                {[e.equipment_type, e.model].filter(Boolean).join(' · ')}
                {e.serial_number && <small>SN {e.serial_number}</small>}
              </td>
              <td>{e.location ?? '—'}</td>
              <td>
                {e.lifecycle_status === 'active' ? (
                  <Badge color="green">В эксплуатации</Badge>
                ) : (
                  <>
                    <Badge color="red">Выведено {fmtDate(e.decommissioned_on)}</Badge>
                    <small>Причина: {e.decommission_reason}</small>
                  </>
                )}
              </td>
              <td>
                <button className="sm-link" onClick={() => setDialog({ eq: e, mode: 'edit' })}>
                  {e.lifecycle_status === 'active' && !archived ? 'Изменить' : 'Просмотр'}
                </button>
                {e.lifecycle_status === 'active' && !archived && (
                  <>
                    {' · '}
                    <button className="sm-link" onClick={() => setDialog({ eq: e, mode: 'decommission' })}>
                      Вывести из эксплуатации
                    </button>
                    {' · '}
                    <button
                      className="sm-link"
                      onClick={async () => {
                        if (!confirm(`Удалить «${e.name}»? Удаление возможно только без истории ТО.`)) return;
                        try {
                          setError(null);
                          await api.del(`/equipment/${e.id}`);
                          toast('Оборудование удалено');
                          reload();
                        } catch (err) {
                          setError(err);
                        }
                      }}
                    >
                      Удалить
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {sys.data && sys.data.regulations.length > 0 && (
        <p className="sm-muted sm-small" style={{ marginTop: 14 }}>
          Регламенты системы:{' '}
          {sys.data.regulations.map((r) => `${r.name} (${REG_STATUS_LABELS[r.status].toLowerCase()})`).join(', ')}. <Link to="/regulations">Перейти к регламентам →</Link>
        </p>
      )}
      {dialog === 'new' && systemId && <EquipmentDialog systemId={systemId} onClose={() => setDialog(null)} onSaved={() => (setDialog(null), toast('Оборудование добавлено'), reload())} />}
      {dialog && typeof dialog === 'object' && dialog.mode === 'edit' && (
        <EquipmentDialog systemId={dialog.eq.system_id} equipment={archived ? { ...dialog.eq, lifecycle_status: 'decommissioned' as const } : dialog.eq} onClose={() => setDialog(null)} onSaved={() => (setDialog(null), toast('Оборудование сохранено'), reload())} />
      )}
      {dialog && typeof dialog === 'object' && dialog.mode === 'decommission' && (
        <DecommissionDialog equipment={dialog.eq} onClose={() => setDialog(null)} onSaved={() => (setDialog(null), toast('Оборудование выведено из эксплуатации'), reload())} />
      )}
    </>
  );
}

function HistoryTab({ objectId }: { objectId: number }) {
  const { data, error } = useLoad(() => api.get<Page<TaskListItem>>(`/tasks${qs({ object_id: objectId, page_size: 100 })}`), [objectId]);
  return (
    <>
      <ErrorBox error={error} />
      <Table headers={['Задание', 'Исходный срок', 'Текущий срок', 'Исполнитель', 'Статус', '']} empty="Заданий по объекту ещё не было">
        {data?.items.map((t) => (
          <tr key={t.id}>
            <td>
              <b>{t.task_number}</b>
              <small>{systemTitle(t.system_name, t.system_type)}</small>
            </td>
            <td>{fmtDate(t.original_due_date)}</td>
            <td>{fmtDate(t.current_due_date)}</td>
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
    </>
  );
}
