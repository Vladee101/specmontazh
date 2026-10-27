import type { SystemType, TaskStatus } from '../db/types.js';

export const SYSTEM_TYPES: readonly SystemType[] = ['fire_alarm', 'evacuation_alert', 'security_alarm', 'video_surveillance'];

export const SYSTEM_TYPE_LABELS: Record<SystemType, string> = {
  fire_alarm: 'Пожарная сигнализация',
  evacuation_alert: 'СОУЭ',
  security_alarm: 'Охранная сигнализация',
  video_surveillance: 'Видеонаблюдение',
};

export const TASK_STATUSES: readonly TaskStatus[] = ['created', 'assigned', 'in_progress', 'in_review', 'rework', 'accepted', 'cancelled'];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  created: 'Создано',
  assigned: 'Назначено',
  in_progress: 'В работе',
  in_review: 'На проверке',
  rework: 'На доработке',
  accepted: 'Принято',
  cancelled: 'Отменено',
};

/** Незавершённые задания: блокируют архив, вывод оборудования и смену роли инженера. */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['created', 'assigned', 'in_progress', 'in_review', 'rework'];

/**
 * Типы оборудования. Начальный список — по макетам; окончательный набор
 * присылает заказчик (спецификация, раздел 13). В БД это непустой текст,
 * набор проверяет приложение.
 */
export const EQUIPMENT_TYPES: readonly string[] = [
  'Приёмно-контрольный прибор',
  'Извещатель',
  'Оповещатель',
  'Усилитель',
  'Камера',
  'Видеорегистратор',
  'Источник питания',
];
