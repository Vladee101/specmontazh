export type Role = 'admin' | 'manager' | 'engineer';
export type SystemType = 'fire_alarm' | 'evacuation_alert' | 'security_alarm' | 'video_surveillance';
export type TaskStatus = 'created' | 'assigned' | 'in_progress' | 'in_review' | 'rework' | 'accepted' | 'cancelled';
export type CheckResult = 'passed' | 'deviation' | 'not_applicable' | 'not_checked';

export const ROLE_LABELS: Record<Role, string> = { admin: 'Администратор', manager: 'Руководитель', engineer: 'Инженер' };

export const SYSTEM_TYPE_LABELS: Record<SystemType, string> = {
  fire_alarm: 'Пожарная сигнализация',
  evacuation_alert: 'СОУЭ',
  security_alarm: 'Охранная сигнализация',
  video_surveillance: 'Видеонаблюдение',
};
export const SYSTEM_TYPES = Object.keys(SYSTEM_TYPE_LABELS) as SystemType[];

/** «Название · тип», без повтора, если система названа по типу. */
export function systemTitle(name: string, type: SystemType): string {
  return name.trim().toLowerCase() === SYSTEM_TYPE_LABELS[type].toLowerCase() ? name : `${name} · ${SYSTEM_TYPE_LABELS[type]}`;
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  created: 'Создано',
  assigned: 'Назначено',
  in_progress: 'В работе',
  in_review: 'На проверке',
  rework: 'На доработке',
  accepted: 'Принято',
  cancelled: 'Отменено',
};
export const STATUSES = Object.keys(STATUS_LABELS) as TaskStatus[];
export const STATUS_COLORS: Record<TaskStatus, '' | 'green' | 'orange' | 'red'> = {
  created: '',
  assigned: '',
  in_progress: 'green',
  in_review: 'orange',
  rework: 'orange',
  accepted: 'green',
  cancelled: '',
};
export const OPEN_STATUSES: TaskStatus[] = ['created', 'assigned', 'in_progress', 'rework'];

export const RESULT_LABELS: Record<CheckResult, string> = {
  passed: 'Соответствует',
  deviation: 'Выявлено отклонение',
  not_applicable: 'Не применимо',
  not_checked: 'Не проверено',
};
export const RESULT_COLORS: Record<CheckResult, 'green' | 'orange' | 'red' | ''> = {
  passed: 'green',
  deviation: 'orange',
  not_applicable: '',
  not_checked: 'red',
};
export const COMMENT_HINTS: Record<CheckResult, string> = {
  passed: 'Комментарий (необязательно)',
  deviation: 'Опишите замечание',
  not_applicable: 'Обоснование обязательно',
  not_checked: 'Причина обязательна',
};

export const REG_STATUS_LABELS = { draft: 'Черновик', active: 'Действует', paused: 'Приостановлен' } as const;

export function intervalLabel(months: number): string {
  if (months === 1) return 'Каждый месяц';
  const mod10 = months % 10;
  const mod100 = months % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'месяц' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'месяца' : 'месяцев';
  return `Каждые ${months} ${word}`;
}
