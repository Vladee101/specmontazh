// Диалоги справочников: объект, система, оборудование, вывод из эксплуатации, архив.
import { api } from '../api';
import { todayMsk } from '../format';
import { SYSTEM_TYPE_LABELS, SYSTEM_TYPES, type SystemType } from '../labels';
import type { Equipment, LcSystem, ServiceObject } from '../types';
import { Field, Modal, useFieldErrors, useFormState, useLoad } from '../ui';

export function ObjectDialog({ object, onClose, onSaved }: { object?: ServiceObject; onClose(): void; onSaved(o: ServiceObject): void }) {
  const [v, set] = useFormState({
    name: object?.name ?? '',
    customer_name: object?.customer_name ?? '',
    address: object?.address ?? '',
    contact_name: object?.contact_name ?? '',
    contact_phone: object?.contact_phone ?? '',
    notes: object?.notes ?? '',
  });
  const e = useFieldErrors();
  return (
    <Modal
      title={object ? 'Объект обслуживания' : 'Новый объект'}
      onClose={onClose}
      onSubmit={() =>
        e.run(async () => onSaved(object ? await api.patch<ServiceObject>(`/objects/${object.id}`, { ...v, version: object.version }) : await api.post<ServiceObject>('/objects', v)))
      }
    >
      <Field label="Название объекта" error={e.of('name')}>
        <input value={v.name} onChange={(x) => set('name', x.target.value)} placeholder="Например, БЦ «Северный»" />
      </Field>
      <Field label="Заказчик (строкой)" error={e.of('customer_name')}>
        <input value={v.customer_name} onChange={(x) => set('customer_name', x.target.value)} placeholder="Название организации" />
      </Field>
      <Field label="Адрес" error={e.of('address')}>
        <input value={v.address} onChange={(x) => set('address', x.target.value)} />
      </Field>
      <Field label="Контактное лицо" error={e.of('contact_name')}>
        <input value={v.contact_name} onChange={(x) => set('contact_name', x.target.value)} />
      </Field>
      <Field label="Телефон" error={e.of('contact_phone')}>
        <input value={v.contact_phone} onChange={(x) => set('contact_phone', x.target.value)} inputMode="tel" />
      </Field>
      <Field label="Примечание" error={e.of('notes')}>
        <textarea value={v.notes} onChange={(x) => set('notes', x.target.value)} />
      </Field>
    </Modal>
  );
}

export function SystemDialog({
  objectId,
  system,
  typeLocked,
  onClose,
  onSaved,
}: {
  objectId: number;
  system?: LcSystem;
  typeLocked?: boolean;
  onClose(): void;
  onSaved(s: LcSystem): void;
}) {
  const [v, set] = useFormState({
    name: system?.name ?? '',
    system_type: (system?.system_type ?? '') as SystemType | '',
    location: system?.location ?? '',
    description: system?.description ?? '',
  });
  const e = useFieldErrors();
  return (
    <Modal
      title={system ? `Система «${system.name}»` : 'Новая система'}
      onClose={onClose}
      onSubmit={() =>
        e.run(async () => {
          const body = { ...v, system_type: v.system_type || undefined };
          onSaved(system ? await api.patch<LcSystem>(`/systems/${system.id}`, { ...body, version: system.version }) : await api.post<LcSystem>('/systems', { ...body, object_id: objectId }));
        })
      }
    >
      <Field label="Название" error={e.of('name')}>
        <input value={v.name} onChange={(x) => set('name', x.target.value)} />
      </Field>
      <Field label="Тип системы" error={e.of('system_type')}>
        <select value={v.system_type} disabled={typeLocked} onChange={(x) => set('system_type', x.target.value as SystemType)}>
          <option value="">Выберите тип</option>
          {SYSTEM_TYPES.map((t) => (
            <option key={t} value={t}>
              {SYSTEM_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </Field>
      {typeLocked && <p className="sm-muted sm-small">Тип нельзя менять: у системы есть оборудование, регламенты или задания. Перенос между объектами не предусмотрен.</p>}
      <Field label="Расположение" error={e.of('location')}>
        <input value={v.location} onChange={(x) => set('location', x.target.value)} />
      </Field>
      <Field label="Описание" error={e.of('description')}>
        <textarea value={v.description} onChange={(x) => set('description', x.target.value)} />
      </Field>
    </Modal>
  );
}

export function EquipmentDialog({ systemId, equipment, onClose, onSaved }: { systemId: number; equipment?: Equipment; onClose(): void; onSaved(e: Equipment): void }) {
  const types = useLoad(() => api.get<{ items: string[] }>('/equipment-types'), []);
  const [v, set] = useFormState({
    name: equipment?.name ?? '',
    equipment_type: equipment?.equipment_type ?? '',
    model: equipment?.model ?? '',
    serial_number: equipment?.serial_number ?? '',
    location: equipment?.location ?? '',
    installed_on: equipment?.installed_on ?? '',
  });
  const e = useFieldErrors();
  const readOnly = equipment?.lifecycle_status === 'decommissioned';
  return (
    <Modal
      title={equipment ? equipment.name : 'Новое оборудование'}
      onClose={onClose}
      onSubmit={
        readOnly
          ? undefined
          : () =>
              e.run(async () =>
                onSaved(equipment ? await api.patch<Equipment>(`/equipment/${equipment.id}`, { ...v, version: equipment.version }) : await api.post<Equipment>('/equipment', { ...v, system_id: systemId })),
              )
      }
    >
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
        <Field label="Название" error={e.of('name')}>
          <input value={v.name} onChange={(x) => set('name', x.target.value)} placeholder="Камера К-05" />
        </Field>
        <Field label="Тип оборудования" error={e.of('equipment_type')}>
          <select value={v.equipment_type} onChange={(x) => set('equipment_type', x.target.value)}>
            <option value="">Выберите тип</option>
            {types.data?.items.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <div className="sm-fieldgrid">
          <Field label="Модель" error={e.of('model')}>
            <input value={v.model} onChange={(x) => set('model', x.target.value)} />
          </Field>
          <Field label="Серийный номер" error={e.of('serial_number')}>
            <input value={v.serial_number} onChange={(x) => set('serial_number', x.target.value)} />
          </Field>
          <Field label="Расположение" error={e.of('location')}>
            <input value={v.location} onChange={(x) => set('location', x.target.value)} />
          </Field>
          <Field label="Дата установки" error={e.of('installed_on')}>
            <input type="date" value={v.installed_on} onChange={(x) => set('installed_on', x.target.value)} />
          </Field>
        </div>
      </fieldset>
      {readOnly ? (
        <p className="sm-warning">
          Выведено из эксплуатации {equipment.decommissioned_on}: {equipment.decommission_reason}. В новые задания не входит, прежние результаты сохранены.
        </p>
      ) : (
        <p className="sm-muted sm-small">Набор типов оборудования согласуется с заказчиком. При физической замене старое устройство выводят вручную и добавляют новое: связи между ними нет.</p>
      )}
    </Modal>
  );
}

export function DecommissionDialog({ equipment, onClose, onSaved }: { equipment: Equipment; onClose(): void; onSaved(e: Equipment): void }) {
  const [v, set] = useFormState({ decommissioned_on: todayMsk(), reason: '' });
  const e = useFieldErrors();
  return (
    <Modal
      title={`Вывести из эксплуатации: ${equipment.name}`}
      submitLabel="Вывести"
      danger
      onClose={onClose}
      onSubmit={() => e.run(async () => onSaved(await api.post<Equipment>(`/equipment/${equipment.id}/decommission`, { ...v, version: equipment.version })))}
    >
      <Field label="Дата вывода" error={e.of('decommissioned_on')}>
        <input type="date" value={v.decommissioned_on} onChange={(x) => set('decommissioned_on', x.target.value)} />
      </Field>
      <Field label="Причина" error={e.of('reason')}>
        <textarea value={v.reason} onChange={(x) => set('reason', x.target.value)} placeholder="Например, физический износ" />
      </Field>
      <p className="sm-muted sm-small">Устройство исключается из новых заданий, прежние результаты сохраняются. Если устройство входит в незавершённое задание, вывод будет отклонён.</p>
    </Modal>
  );
}

export function ArchiveDialog({ title, text, onClose, onConfirm }: { title: string; text: string; onClose(): void; onConfirm(): Promise<void> }) {
  return (
    <Modal title={title} submitLabel="Архивировать" danger onClose={onClose} onSubmit={onConfirm}>
      <p>{text}</p>
      <p className="sm-muted sm-small" style={{ marginTop: 10 }}>
        Незавершённые задания блокируют архив: сначала примите или отмените их. Восстановления из архива в MVP нет.
      </p>
    </Modal>
  );
}
