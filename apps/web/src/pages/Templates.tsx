// Шаблоны чек-листов (раздел руководителя). Один шаблон на тип системы; конструктора и версий нет.
import { useState } from 'react';
import { api } from '../api';
import { SYSTEM_TYPE_LABELS, type SystemType } from '../labels';
import type { Template, TemplateItem } from '../types';
import { Badge, ErrorBox, Field, Heading, Loading, Modal, Shell, Table, Tabs, useFieldErrors, useFormState, useLoad, useToast } from '../ui';

type TemplateDetail = Template & { items: TemplateItem[]; active_regulations_count: number };

export function Templates() {
  const toast = useToast();
  const list = useLoad(() => api.get<{ items: Template[] }>('/templates'), []);
  const [type, setType] = useState<SystemType>('video_surveillance');
  const current = list.data?.items.find((t) => t.system_type === type);
  const detail = useLoad(async () => (current ? api.get<TemplateDetail>(`/templates/${current.id}`) : null), [current?.id]);
  const [dialog, setDialog] = useState<null | { item?: TemplateItem }>(null);
  const [error, setError] = useState<unknown>(null);

  const tpl = detail.data;
  const act = async (fn: () => Promise<unknown>, message: string) => {
    setError(null);
    try {
      await fn();
      toast(message);
    } catch (e) {
      setError(e);
    } finally {
      void detail.reload();
    }
  };
  const move = (index: number, delta: number) => {
    if (!tpl) return;
    const ids = tpl.items.map((i) => i.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved!);
    void act(() => api.put(`/templates/${tpl.id}/items/order`, { version: tpl.version, item_ids: ids }), 'Порядок пунктов изменён');
  };

  return (
    <Shell section="Шаблоны">
      <Heading title="Шаблоны чек-листов" sub="Раздел руководителя: пункты, обязательность и порядок проверок по типу системы" />
      <div className="sm-context" style={{ marginBottom: 18 }}>
        Правка шаблона не меняет уже выданные задания: пункты копируются в задание при его создании. Содержание пунктов — пример, реальные проверки
        согласуются с организацией. Конструктора и версий шаблонов нет.
      </div>
      <Tabs<SystemType> items={(Object.keys(SYSTEM_TYPE_LABELS) as SystemType[]).map((t) => [t, SYSTEM_TYPE_LABELS[t]] as const)} value={type} onChange={setType} />
      <ErrorBox error={list.error ?? detail.error ?? error} />
      {!tpl ? (
        <Loading />
      ) : (
        <>
          <div className="sm-actions" style={{ marginBottom: 12 }}>
            <button className="sm-primary" onClick={() => setDialog({})}>
              + Добавить пункт
            </button>
            <label className="sm-inline">
              <input
                type="checkbox"
                checked={tpl.is_active}
                onChange={(e) => act(() => api.patch(`/templates/${tpl.id}`, { version: tpl.version, is_active: e.target.checked }), e.target.checked ? 'Шаблон активен' : 'Шаблон отключён')}
              />
              Шаблон активен
            </label>
            <span className="sm-muted sm-small">Действующих регламентов: {tpl.active_regulations_count}</span>
          </div>
          <Table headers={['№', 'Раздел', 'Проверка', 'Применяется к', 'Обязательная', '']} empty="В шаблоне нет пунктов">
            {tpl.items.map((x, i) => (
              <tr key={x.id}>
                <td>{x.position}</td>
                <td>{x.section_name ?? '—'}</td>
                <td>
                  <b>{x.check_text}</b>
                </td>
                <td>{x.target_type === 'system' ? 'Вся система' : `Оборудование: ${x.equipment_type_filter?.join(', ') ?? 'все типы'}`}</td>
                <td>{x.is_required ? <Badge color="green">Да</Badge> : <Badge>Нет</Badge>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="sm-link" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Выше">
                    ↑
                  </button>{' '}
                  <button className="sm-link" disabled={i === tpl.items.length - 1} onClick={() => move(i, 1)} aria-label="Ниже">
                    ↓
                  </button>
                  {' · '}
                  <button className="sm-link" onClick={() => setDialog({ item: x })}>
                    Изменить
                  </button>
                  {' · '}
                  <button
                    className="sm-link"
                    onClick={() => confirm(`Удалить пункт «${x.check_text}»?`) && act(() => api.del(`/templates/${tpl.id}/items/${x.id}`, { version: tpl.version }), 'Пункт удалён. Созданные задания не изменились.')}
                  >
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
          </Table>
          <p className="sm-muted sm-small" style={{ marginTop: 14 }}>
            Шаблон с действующими регламентами должен содержать хотя бы один пункт. Фильтр по типу оборудования не даёт появиться проверке камеры у
            регистратора.
          </p>
        </>
      )}
      {dialog && tpl && (
        <ItemDialog
          template={tpl}
          item={dialog.item}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            toast('Пункт сохранён. Уже созданные задания не изменились.');
            void detail.reload();
          }}
        />
      )}
    </Shell>
  );
}

function ItemDialog({ template, item, onClose, onSaved }: { template: TemplateDetail; item?: TemplateItem; onClose(): void; onSaved(): void }) {
  const types = useLoad(() => api.get<{ items: string[] }>('/equipment-types'), []);
  const [v, set] = useFormState({
    section_name: item?.section_name ?? '',
    check_text: item?.check_text ?? '',
    target_type: item?.target_type ?? ('system' as 'system' | 'equipment'),
    filter: item?.equipment_type_filter ?? ([] as string[]),
    is_required: item?.is_required ?? true,
  });
  const e = useFieldErrors();
  const toggle = (t: string) => set('filter', v.filter.includes(t) ? v.filter.filter((x) => x !== t) : [...v.filter, t]);

  return (
    <Modal
      title="Пункт шаблона"
      onClose={onClose}
      onSubmit={() =>
        e.run(async () => {
          const body = {
            version: template.version,
            section_name: v.section_name,
            check_text: v.check_text,
            target_type: v.target_type,
            equipment_type_filter: v.target_type === 'equipment' && v.filter.length ? v.filter : null,
            is_required: v.is_required,
          };
          if (item) await api.patch(`/templates/${template.id}/items/${item.id}`, body);
          else await api.post(`/templates/${template.id}/items`, body);
          onSaved();
        })
      }
    >
      <Field label="Раздел" error={e.of('section_name')}>
        <input value={v.section_name} onChange={(x) => set('section_name', x.target.value)} />
      </Field>
      <Field label="Текст проверки" error={e.of('check_text')}>
        <textarea value={v.check_text} onChange={(x) => set('check_text', x.target.value)} />
      </Field>
      <Field label="Применяется к" error={e.of('target_type')}>
        <select value={v.target_type} onChange={(x) => set('target_type', x.target.value as 'system' | 'equipment')}>
          <option value="system">Вся система</option>
          <option value="equipment">Каждому устройству (по типам)</option>
        </select>
      </Field>
      {v.target_type === 'equipment' && (
        <fieldset style={{ border: '1px solid var(--sm-line)', borderRadius: 7, padding: '8px 12px' }}>
          <legend className="sm-small sm-muted">Типы оборудования (пусто — все)</legend>
          {types.data?.items.map((t) => (
            <label key={t} className="sm-inline" style={{ margin: '6px 0' }}>
              <input type="checkbox" checked={v.filter.includes(t)} onChange={() => toggle(t)} />
              <span style={{ color: 'var(--sm-ink)', fontSize: 13 }}>{t}</span>
            </label>
          ))}
          {e.of('equipment_type_filter') && <span className="sm-field-error">{e.of('equipment_type_filter')}</span>}
        </fieldset>
      )}
      <label className="sm-inline">
        <input type="checkbox" checked={v.is_required} onChange={(x) => set('is_required', x.target.checked)} />
        <span style={{ color: 'var(--sm-ink)', fontSize: 13 }}>Обязательная проверка</span>
      </label>
      <p className="sm-muted sm-small">Уже созданные задания не изменятся.</p>
    </Modal>
  );
}
