-- Проверка ограничений schema.sql (ТЗ MVP 1.2). Каждая проверка идёт в подтранзакции и откатывается.
\set ON_ERROR_STOP off
CREATE TEMP TABLE results (label text, expected text, got text, ok boolean);

CREATE OR REPLACE FUNCTION pg_temp.try(label text, expected text, stmt text) RETURNS void AS $$
DECLARE err text;
BEGIN
    BEGIN
        EXECUTE stmt;
        err := NULL;
        RAISE EXCEPTION 'rollback_marker';
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLERRM = 'rollback_marker' THEN
                err := NULL;
            ELSE
                err := SQLSTATE || ' ' || split_part(SQLERRM, E'\n', 1);
            END IF;
    END;
    INSERT INTO results VALUES (label, expected,
        coalesce(err, 'ok'),
        (expected = 'fail' AND err IS NOT NULL) OR (expected = 'ok' AND err IS NULL));
END $$ LANGUAGE plpgsql;

-- ---------- Исходные данные ----------
INSERT INTO users (login, password_hash, full_name, role) VALUES
 ('admin', 'h', 'Админ', 'admin'),          -- 1
 ('boss',  'h', 'Руководитель', 'manager'), -- 2
 ('eng1',  'h', 'Инженер Один', 'engineer'),-- 3
 ('eng2',  'h', 'Инженер Два', 'engineer'); -- 4
INSERT INTO service_object (created_by_id, name, customer_name, address) VALUES (2, 'Офис', 'ООО Тест', 'ул. Ленина, 5'); -- 1
INSERT INTO low_current_system (object_id, name, system_type) VALUES
 (1, 'АПС 1 этаж', 'fire_alarm'),        -- 1
 (1, 'Камеры периметр', 'video_surveillance'); -- 2
INSERT INTO equipment (system_id, name, equipment_type) VALUES
 (1, 'Извещатель 1', 'smoke_detector'),  -- 1
 (1, 'Извещатель 2', 'smoke_detector'),  -- 2
 (2, 'Камера 1', 'camera');              -- 3
INSERT INTO checklist_template (name, system_type) VALUES ('Шаблон АПС', 'fire_alarm'), ('Шаблон видео', 'video_surveillance'); -- 1, 2
INSERT INTO checklist_template (name, system_type, is_active) VALUES ('Шаблон СКУД-архив', 'security_alarm', false); -- 3 (неактивный, без пунктов)
INSERT INTO checklist_template (name, system_type) VALUES ('Пустой СОУЭ', 'evacuation_alert'); -- 4 (без пунктов)
INSERT INTO template_item (template_id, position, section_name, check_text, target_type, equipment_type_filter, is_required) VALUES
 (1, 1, 'Прибор', 'Проверка питания', 'system', NULL, true),
 (1, 2, 'Извещатели', 'Проверка срабатывания', 'equipment', '["smoke_detector"]', true),
 (2, 1, 'Камеры', 'Проверка изображения', 'equipment', NULL, false);
INSERT INTO maintenance_regulation (system_id, template_id, created_by_id, name, interval_value, schedule_anchor_date, next_due_date, status, activated_at)
 VALUES (1, 1, 2, 'ТО АПС ежеквартально', 3, '2026-11-01', '2026-11-01', 'active', now()); -- 1
INSERT INTO maintenance_task (regulation_id, system_id, original_due_date, current_due_date) VALUES (1, 1, '2026-11-01', '2026-11-01'); -- 1 (created)
INSERT INTO task_status_history (task_id, previous_status, new_status) VALUES (1, NULL, 'created');
INSERT INTO task_equipment (task_id, equipment_id) VALUES (1, 1), (1, 2); -- 1, 2
INSERT INTO task_check (task_id, task_equipment_id, position, check_text, is_required) VALUES
 (1, NULL, 1, 'Проверка питания', true),
 (1, 1, 2, 'Проверка срабатывания', true);

-- Задание №2 в статусе «В работе» (для проверок переходов)
INSERT INTO maintenance_regulation (system_id, template_id, created_by_id, name, interval_value, schedule_anchor_date, next_due_date, status, activated_at)
 VALUES (2, 2, 2, 'ТО видео', 1, '2026-12-01', '2026-12-01', 'draft', NULL); -- 2
INSERT INTO maintenance_task (regulation_id, system_id, original_due_date, current_due_date, status, assigned_engineer_id, started_at)
 VALUES (2, 2, '2026-12-01', '2026-12-01', 'in_progress', 3, now()); -- 2

-- ---------- Пользователи ----------
SELECT pg_temp.try('users: дубль логина без учёта регистра', 'fail', $$INSERT INTO users (login, password_hash, full_name, role) VALUES ('ADMIN', 'h', 'X', 'admin')$$);
SELECT pg_temp.try('users: недопустимая роль', 'fail', $$INSERT INTO users (login, password_hash, full_name, role) VALUES ('x1', 'h', 'X', 'boss')$$);
SELECT pg_temp.try('users: пустой логин', 'fail', $$INSERT INTO users (login, password_hash, full_name, role) VALUES ('  ', 'h', 'X', 'admin')$$);
SELECT pg_temp.try('users: логин с пробелами по краям', 'fail', $$INSERT INTO users (login, password_hash, full_name, role) VALUES (' x1', 'h', 'X', 'admin')$$);
SELECT pg_temp.try('users: пустое ФИО', 'fail', $$INSERT INTO users (login, password_hash, full_name, role) VALUES ('x2', 'h', ' ', 'admin')$$);
SELECT pg_temp.try('users: пустой хэш пароля', 'fail', $$INSERT INTO users (login, password_hash, full_name, role) VALUES ('x3', '', 'X', 'admin')$$);
SELECT pg_temp.try('users: валидный пользователь', 'ok', $$INSERT INTO users (login, password_hash, full_name, role) VALUES ('x4', 'h', 'X', 'engineer')$$);
SELECT pg_temp.try('users: version растёт при обновлении', 'ok', $q$UPDATE users SET full_name = 'Новое' WHERE id = 3; DO $x$ BEGIN IF (SELECT version FROM users WHERE id = 3) <> 2 THEN RAISE EXCEPTION 'version не вырос'; END IF; END $x$$q$);
SELECT pg_temp.try('users: нельзя удалить автора объекта', 'fail', $$DELETE FROM users WHERE id = 2$$);

-- ---------- Объекты, системы, оборудование ----------
SELECT pg_temp.try('object: пустой заказчик', 'fail', $$INSERT INTO service_object (created_by_id, name, customer_name, address) VALUES (2, 'О', ' ', 'А')$$);
SELECT pg_temp.try('object: пустой адрес', 'fail', $$INSERT INTO service_object (created_by_id, name, customer_name, address) VALUES (2, 'О', 'З', '')$$);
SELECT pg_temp.try('object: архив без даты', 'fail', $$UPDATE service_object SET is_archived = true WHERE id = 1$$);
SELECT pg_temp.try('object: архив с датой', 'ok', $$UPDATE service_object SET is_archived = true, archived_at = now() WHERE id = 1$$);
SELECT pg_temp.try('object: контакты необязательны', 'ok', $$INSERT INTO service_object (created_by_id, name, customer_name, address) VALUES (2, 'О2', 'З', 'А')$$);
SELECT pg_temp.try('object: нельзя удалить объект с системами', 'fail', $$DELETE FROM service_object WHERE id = 1$$);
SELECT pg_temp.try('object: пустой объект удаляется', 'ok', $$INSERT INTO service_object (created_by_id, name, customer_name, address) VALUES (2, 'О3', 'З', 'А'); DELETE FROM service_object WHERE name = 'О3'$$);
SELECT pg_temp.try('system: недопустимый тип', 'fail', $$INSERT INTO low_current_system (object_id, name, system_type) VALUES (1, 'С', 'skud')$$);
SELECT pg_temp.try('system: нельзя удалить систему с оборудованием', 'fail', $$DELETE FROM low_current_system WHERE id = 1$$);
SELECT pg_temp.try('system: тип с оборудованием не меняется', 'fail', $$UPDATE low_current_system SET system_type = 'security_alarm' WHERE id = 1$$);
SELECT pg_temp.try('system: тип пустой системы меняется', 'ok', $$INSERT INTO low_current_system (object_id, name, system_type) VALUES (1, 'Пустая', 'fire_alarm'); UPDATE low_current_system SET system_type = 'security_alarm' WHERE name = 'Пустая'$$);
SELECT pg_temp.try('system: имя меняется при наличии оборудования', 'ok', $$UPDATE low_current_system SET name = 'Новое имя' WHERE id = 1$$);
SELECT pg_temp.try('equipment: пустой тип', 'fail', $$INSERT INTO equipment (system_id, name, equipment_type) VALUES (1, 'Э', ' ')$$);
SELECT pg_temp.try('equipment: недопустимый lifecycle_status', 'fail', $$UPDATE equipment SET lifecycle_status = 'broken' WHERE id = 1$$);
SELECT pg_temp.try('equipment: списание без причины', 'fail', $$UPDATE equipment SET lifecycle_status = 'decommissioned', decommissioned_on = '2026-10-01' WHERE id = 1$$);
SELECT pg_temp.try('equipment: списание без даты', 'fail', $$UPDATE equipment SET lifecycle_status = 'decommissioned', decommission_reason = 'износ' WHERE id = 1$$);
SELECT pg_temp.try('equipment: списание с датой и причиной', 'ok', $$UPDATE equipment SET lifecycle_status = 'decommissioned', decommissioned_on = '2026-10-01', decommission_reason = 'износ' WHERE id = 1$$);
SELECT pg_temp.try('equipment: причина списания у действующего', 'fail', $$UPDATE equipment SET decommission_reason = 'износ' WHERE id = 1$$);
SELECT pg_temp.try('equipment: списан раньше установки', 'fail', $$UPDATE equipment SET installed_on = '2026-05-01', lifecycle_status = 'decommissioned', decommissioned_on = '2026-04-01', decommission_reason = 'x' WHERE id = 1$$);
SELECT pg_temp.try('equipment: серийный номер необязателен и не уникален', 'ok', $$UPDATE equipment SET serial_number = 'SN1' WHERE id IN (1, 2)$$);
SELECT pg_temp.try('equipment: нельзя удалить оборудование в задании', 'fail', $$DELETE FROM equipment WHERE id = 1$$);
SELECT pg_temp.try('equipment: свободное оборудование удаляется', 'ok', $$INSERT INTO equipment (system_id, name, equipment_type) VALUES (2, 'Э', 'camera'); DELETE FROM equipment WHERE name = 'Э'$$);

-- ---------- Шаблоны ----------
SELECT pg_temp.try('template: второй шаблон на тип системы', 'fail', $$INSERT INTO checklist_template (name, system_type) VALUES ('Дубль', 'fire_alarm')$$);
SELECT pg_temp.try('template: недопустимый тип', 'fail', $$INSERT INTO checklist_template (name, system_type) VALUES ('Т', 'skud')$$);
SELECT pg_temp.try('item: дубль позиции', 'fail', $$INSERT INTO template_item (template_id, position, check_text, target_type) VALUES (1, 1, 'x', 'system')$$);
SELECT pg_temp.try('item: нулевая позиция', 'fail', $$INSERT INTO template_item (template_id, position, check_text, target_type) VALUES (1, 0, 'x', 'system')$$);
SELECT pg_temp.try('item: недопустимый target_type', 'fail', $$INSERT INTO template_item (template_id, position, check_text, target_type) VALUES (1, 9, 'x', 'room')$$);
SELECT pg_temp.try('item: фильтр у пункта по системе', 'fail', $$INSERT INTO template_item (template_id, position, check_text, target_type, equipment_type_filter) VALUES (1, 9, 'x', 'system', '["camera"]')$$);
SELECT pg_temp.try('item: фильтр не массив', 'fail', $$INSERT INTO template_item (template_id, position, check_text, target_type, equipment_type_filter) VALUES (1, 9, 'x', 'equipment', '"camera"')$$);
SELECT pg_temp.try('item: пустой массив фильтра', 'fail', $$INSERT INTO template_item (template_id, position, check_text, target_type, equipment_type_filter) VALUES (1, 9, 'x', 'equipment', '[]')$$);
SELECT pg_temp.try('item: корректный пункт с фильтром', 'ok', $$INSERT INTO template_item (template_id, position, check_text, target_type, equipment_type_filter) VALUES (1, 9, 'x', 'equipment', '["smoke_detector","heat_detector"]')$$);
SELECT pg_temp.try('item: пустой текст', 'fail', $$INSERT INTO template_item (template_id, position, check_text, target_type) VALUES (1, 9, ' ', 'system')$$);
SELECT pg_temp.try('item: правка шаблона не меняет копии в задании', 'ok', $q$UPDATE template_item SET check_text = 'Изменено' WHERE template_id = 1 AND position = 1; DO $x$ BEGIN IF (SELECT check_text FROM task_check WHERE task_id = 1 AND position = 1) <> 'Проверка питания' THEN RAISE EXCEPTION 'копия изменилась'; END IF; END $x$$q$);
SELECT pg_temp.try('item: удаление пункта сохраняет копию в задании', 'ok', $q$INSERT INTO template_item (template_id, position, check_text, target_type) VALUES (1, 20, 'Временный', 'system'); INSERT INTO task_check (task_id, source_template_item_id, position, check_text, is_required) SELECT 1, id, 20, 'Временный', false FROM template_item WHERE template_id = 1 AND position = 20; DELETE FROM template_item WHERE template_id = 1 AND position = 20; DO $x$ BEGIN IF NOT EXISTS (SELECT 1 FROM task_check WHERE task_id = 1 AND position = 20 AND source_template_item_id IS NULL) THEN RAISE EXCEPTION 'копия потеряна'; END IF; END $x$$q$);

-- ---------- Регламенты ----------
SELECT pg_temp.try('reg: период 0', 'fail', $$UPDATE maintenance_regulation SET interval_value = 0 WHERE id = 1$$);
SELECT pg_temp.try('reg: единица кроме месяца', 'fail', $$UPDATE maintenance_regulation SET interval_unit = 'year' WHERE id = 1$$);
SELECT pg_temp.try('reg: недопустимый статус', 'fail', $$UPDATE maintenance_regulation SET status = 'stopped' WHERE id = 1$$);
SELECT pg_temp.try('reg: active без activated_at', 'fail', $$UPDATE maintenance_regulation SET status = 'active', activated_at = NULL WHERE id = 2$$);
SELECT pg_temp.try('reg: paused без paused_at', 'fail', $$UPDATE maintenance_regulation SET status = 'paused' WHERE id = 1$$);
SELECT pg_temp.try('reg: пауза и возобновление', 'ok', $q$UPDATE maintenance_regulation SET status = 'paused', paused_at = now() WHERE id = 1; UPDATE maintenance_regulation SET status = 'active', paused_at = NULL WHERE id = 1$q$);
SELECT pg_temp.try('reg: ближайшая дата раньше опорной', 'fail', $$UPDATE maintenance_regulation SET next_due_date = '2026-10-01' WHERE id = 1$$);
SELECT pg_temp.try('reg: шаблон другого типа', 'fail', $$INSERT INTO maintenance_regulation (system_id, template_id, created_by_id, name, interval_value, schedule_anchor_date, next_due_date) VALUES (1, 2, 2, 'x', 1, '2027-01-01', '2027-01-01')$$);
SELECT pg_temp.try('reg: активация с неактивным шаблоном', 'fail', $$INSERT INTO low_current_system (object_id, name, system_type) VALUES (1, 'Охрана', 'security_alarm'); INSERT INTO maintenance_regulation (system_id, template_id, created_by_id, name, interval_value, schedule_anchor_date, next_due_date, status, activated_at) SELECT id, 3, 2, 'x', 1, '2027-01-01', '2027-01-01', 'active', now() FROM low_current_system WHERE name = 'Охрана'$$);
SELECT pg_temp.try('reg: активация с шаблоном без пунктов', 'fail', $$INSERT INTO low_current_system (object_id, name, system_type) VALUES (1, 'СОУЭ', 'evacuation_alert'); INSERT INTO maintenance_regulation (system_id, template_id, created_by_id, name, interval_value, schedule_anchor_date, next_due_date, status, activated_at) SELECT id, 4, 2, 'x', 1, '2027-01-01', '2027-01-01', 'active', now() FROM low_current_system WHERE name = 'СОУЭ'$$);
SELECT pg_temp.try('reg: черновик с шаблоном без пунктов допустим', 'ok', $$INSERT INTO low_current_system (object_id, name, system_type) VALUES (1, 'СОУЭ', 'evacuation_alert'); INSERT INTO maintenance_regulation (system_id, template_id, created_by_id, name, interval_value, schedule_anchor_date, next_due_date) SELECT id, 4, 2, 'x', 1, '2027-01-01', '2027-01-01' FROM low_current_system WHERE name = 'СОУЭ'$$);
SELECT pg_temp.try('reg: активация в архивном объекте', 'fail', $$UPDATE service_object SET is_archived = true, archived_at = now() WHERE id = 1; UPDATE maintenance_regulation SET status = 'active', activated_at = now() WHERE id = 2$$);
SELECT pg_temp.try('reg: нельзя удалить регламент с заданием', 'fail', $$DELETE FROM maintenance_regulation WHERE id = 1$$);
SELECT pg_temp.try('reg: тип системы с регламентом не меняется', 'fail', $$UPDATE low_current_system SET system_type = 'security_alarm' WHERE id = 2$$);

-- ---------- Задания: уникальность и согласованность ----------
SELECT pg_temp.try('task: дубль (регламент, исходный срок)', 'fail', $$INSERT INTO maintenance_task (regulation_id, system_id, original_due_date, current_due_date) VALUES (1, 1, '2026-11-01', '2026-11-01')$$);
SELECT pg_temp.try('task: дубль срока даже при отменённом задании', 'fail', $$UPDATE maintenance_task SET status = 'cancelled', cancelled_at = now(), cancelled_by_id = 2, cancellation_reason = 'отказ' WHERE id = 1; INSERT INTO maintenance_task (regulation_id, system_id, original_due_date, current_due_date) VALUES (1, 1, '2026-11-01', '2026-11-01')$$);
SELECT pg_temp.try('task: другой срок того же регламента', 'ok', $$INSERT INTO maintenance_task (regulation_id, system_id, original_due_date, current_due_date) VALUES (1, 1, '2027-02-01', '2027-02-01')$$);
SELECT pg_temp.try('task: система не совпадает с системой регламента', 'fail', $$INSERT INTO maintenance_task (regulation_id, system_id, original_due_date, current_due_date) VALUES (1, 2, '2027-05-01', '2027-05-01')$$);
SELECT pg_temp.try('task: номер формата ТО-NNNNNN выдаётся автоматически', 'ok', $q$INSERT INTO maintenance_task (regulation_id, system_id, original_due_date, current_due_date) VALUES (1, 1, '2027-05-01', '2027-05-01'); DO $x$ BEGIN IF NOT EXISTS (SELECT 1 FROM maintenance_task WHERE original_due_date = '2027-05-01' AND task_number ~ '^ТО-[0-9]{6}$') THEN RAISE EXCEPTION 'нет номера'; END IF; END $x$$q$);
SELECT pg_temp.try('task: дубль номера', 'fail', $q$INSERT INTO maintenance_task (task_number, regulation_id, system_id, original_due_date, current_due_date) SELECT task_number, 1, 1, '2028-01-01', '2028-01-01' FROM maintenance_task WHERE id = 1$q$);
SELECT pg_temp.try('task: номер не меняется', 'fail', $$UPDATE maintenance_task SET task_number = 'ТО-999999' WHERE id = 1$$);
SELECT pg_temp.try('task: исходный срок не меняется', 'fail', $$UPDATE maintenance_task SET original_due_date = '2026-11-05' WHERE id = 1$$);
SELECT pg_temp.try('task: перенос срока не трогает исходный срок', 'ok', $q$UPDATE maintenance_task SET current_due_date = '2026-11-10' WHERE id = 1; INSERT INTO task_deadline_change (task_id, changed_by_id, previous_due_date, new_due_date, reason) VALUES (1, 2, '2026-11-01', '2026-11-10', 'клиент попросил'); DO $x$ BEGIN IF (SELECT original_due_date FROM maintenance_task WHERE id = 1) <> '2026-11-01' THEN RAISE EXCEPTION 'исходный срок сдвинулся'; END IF; END $x$$q$);

-- ---------- Задания: статусы ----------
SELECT pg_temp.try('task: недопустимый статус', 'fail', $$UPDATE maintenance_task SET status = 'done' WHERE id = 1$$);
SELECT pg_temp.try('task: Создано -> Назначено с инженером', 'ok', $$UPDATE maintenance_task SET status = 'assigned', assigned_engineer_id = 3 WHERE id = 1$$);
SELECT pg_temp.try('task: Назначено без инженера', 'fail', $$UPDATE maintenance_task SET status = 'assigned' WHERE id = 1$$);
SELECT pg_temp.try('task: Создано -> В работе (пропуск)', 'fail', $$UPDATE maintenance_task SET status = 'in_progress', assigned_engineer_id = 3, started_at = now() WHERE id = 1$$);
SELECT pg_temp.try('task: Создано -> Принято', 'fail', $$UPDATE maintenance_task SET status = 'accepted' WHERE id = 1$$);
SELECT pg_temp.try('task: инженер у задания «Создано»', 'fail', $$UPDATE maintenance_task SET assigned_engineer_id = 3 WHERE id = 1$$);
SELECT pg_temp.try('task: В работе -> На проверке без фактической даты', 'fail', $$UPDATE maintenance_task SET status = 'in_review', submitted_at = now() WHERE id = 2$$);
SELECT pg_temp.try('task: В работе -> На проверке', 'ok', $$UPDATE maintenance_task SET status = 'in_review', submitted_at = now(), actual_performed_on = '2026-12-01' WHERE id = 2$$);
SELECT pg_temp.try('task: На проверке -> Принято', 'ok', $$UPDATE maintenance_task SET status = 'in_review', submitted_at = now(), actual_performed_on = '2026-12-01' WHERE id = 2; UPDATE maintenance_task SET status = 'accepted', accepted_at = now(), reviewed_by_id = 2 WHERE id = 2$$);
SELECT pg_temp.try('task: Принято без проверяющего', 'fail', $$UPDATE maintenance_task SET status = 'in_review', submitted_at = now(), actual_performed_on = '2026-12-01' WHERE id = 2; UPDATE maintenance_task SET status = 'accepted', accepted_at = now() WHERE id = 2$$);
SELECT pg_temp.try('task: частичное задание нельзя принять', 'fail', $$UPDATE maintenance_task SET status = 'in_review', submitted_at = now(), actual_performed_on = '2026-12-01', is_partial = true WHERE id = 2; UPDATE maintenance_task SET status = 'accepted', accepted_at = now(), reviewed_by_id = 2 WHERE id = 2$$);
SELECT pg_temp.try('task: частичное задание можно отправить', 'ok', $$UPDATE maintenance_task SET status = 'in_review', submitted_at = now(), actual_performed_on = '2026-12-01', is_partial = true WHERE id = 2$$);
SELECT pg_temp.try('task: возврат без комментария', 'fail', $$UPDATE maintenance_task SET status = 'in_review', submitted_at = now(), actual_performed_on = '2026-12-01' WHERE id = 2; UPDATE maintenance_task SET status = 'rework' WHERE id = 2$$);
SELECT pg_temp.try('task: возврат с комментарием и повторная отправка', 'ok', $$UPDATE maintenance_task SET status = 'in_review', submitted_at = now(), actual_performed_on = '2026-12-01' WHERE id = 2; UPDATE maintenance_task SET status = 'rework', review_comment = 'Нет фото' WHERE id = 2; UPDATE maintenance_task SET status = 'in_review' WHERE id = 2$$);
SELECT pg_temp.try('task: Принятое нельзя отменить', 'fail', $$UPDATE maintenance_task SET status = 'in_review', submitted_at = now(), actual_performed_on = '2026-12-01' WHERE id = 2; UPDATE maintenance_task SET status = 'accepted', accepted_at = now(), reviewed_by_id = 2 WHERE id = 2; UPDATE maintenance_task SET status = 'cancelled', cancelled_at = now(), cancelled_by_id = 2, cancellation_reason = 'x' WHERE id = 2$$);
SELECT pg_temp.try('task: Принятое нельзя перенести', 'fail', $$UPDATE maintenance_task SET status = 'in_review', submitted_at = now(), actual_performed_on = '2026-12-01' WHERE id = 2; UPDATE maintenance_task SET status = 'accepted', accepted_at = now(), reviewed_by_id = 2 WHERE id = 2; UPDATE maintenance_task SET current_due_date = '2027-01-01' WHERE id = 2$$);
SELECT pg_temp.try('task: отмена с причиной из «В работе»', 'ok', $$UPDATE maintenance_task SET status = 'cancelled', cancelled_at = now(), cancelled_by_id = 2, cancellation_reason = 'Объект закрыт' WHERE id = 2$$);
SELECT pg_temp.try('task: отмена без причины', 'fail', $$UPDATE maintenance_task SET status = 'cancelled', cancelled_at = now(), cancelled_by_id = 2 WHERE id = 2$$);
SELECT pg_temp.try('task: отмена с пустой причиной', 'fail', $$UPDATE maintenance_task SET status = 'cancelled', cancelled_at = now(), cancelled_by_id = 2, cancellation_reason = '  ' WHERE id = 2$$);
SELECT pg_temp.try('task: отмена из «Создано» без инженера', 'ok', $$UPDATE maintenance_task SET status = 'cancelled', cancelled_at = now(), cancelled_by_id = 2, cancellation_reason = 'x' WHERE id = 1$$);
SELECT pg_temp.try('task: отменённое нельзя возобновить', 'fail', $$UPDATE maintenance_task SET status = 'cancelled', cancelled_at = now(), cancelled_by_id = 2, cancellation_reason = 'x' WHERE id = 2; UPDATE maintenance_task SET status = 'in_progress', cancelled_at = NULL, cancelled_by_id = NULL, cancellation_reason = NULL WHERE id = 2$$);
SELECT pg_temp.try('task: причина отмены у неотменённого', 'fail', $$UPDATE maintenance_task SET cancellation_reason = 'x' WHERE id = 2$$);
SELECT pg_temp.try('task: замена инженера сохраняет статус', 'ok', $$UPDATE maintenance_task SET assigned_engineer_id = 4 WHERE id = 2$$);
SELECT pg_temp.try('task: нельзя удалить пользователя-исполнителя', 'fail', $$DELETE FROM users WHERE id = 3$$);

-- ---------- Оборудование и проверки задания ----------
SELECT pg_temp.try('task_equipment: дубль пары', 'fail', $$INSERT INTO task_equipment (task_id, equipment_id) VALUES (1, 1)$$);
SELECT pg_temp.try('task_equipment: оборудование другой системы', 'fail', $$INSERT INTO task_equipment (task_id, equipment_id) VALUES (1, 3)$$);
SELECT pg_temp.try('task_equipment: оборудование той же системы', 'ok', $$INSERT INTO equipment (system_id, name, equipment_type) VALUES (1, 'Извещатель 3', 'smoke_detector'); INSERT INTO task_equipment (task_id, equipment_id) SELECT 1, id FROM equipment WHERE name = 'Извещатель 3'$$);
SELECT pg_temp.try('task_check: элемент оборудования другого задания', 'fail', $$INSERT INTO task_check (task_id, task_equipment_id, position, check_text, is_required) VALUES (2, 1, 5, 'x', true)$$);
SELECT pg_temp.try('task_check: элемент оборудования своего задания', 'ok', $$INSERT INTO task_check (task_id, task_equipment_id, position, check_text, is_required) VALUES (1, 2, 5, 'x', true)$$);
SELECT pg_temp.try('task_check: пустой текст', 'fail', $$INSERT INTO task_check (task_id, position, check_text, is_required) VALUES (1, 5, ' ', true)$$);
SELECT pg_temp.try('task_check: недопустимый результат', 'fail', $$UPDATE task_check SET result = 'ok', comment = 'c', checked_at = now(), checked_by_id = 3 WHERE id = 1$$);
SELECT pg_temp.try('task_check: «норма» без комментария', 'ok', $$UPDATE task_check SET result = 'passed', checked_at = now(), checked_by_id = 3 WHERE id = 1$$);
SELECT pg_temp.try('task_check: «замечание» без комментария', 'fail', $$UPDATE task_check SET result = 'deviation', checked_at = now(), checked_by_id = 3 WHERE id = 1$$);
SELECT pg_temp.try('task_check: «не применимо» без обоснования', 'fail', $$UPDATE task_check SET result = 'not_applicable', checked_at = now(), checked_by_id = 3 WHERE id = 1$$);
SELECT pg_temp.try('task_check: «не проверено» без причины', 'fail', $$UPDATE task_check SET result = 'not_checked', checked_at = now(), checked_by_id = 3 WHERE id = 1$$);
SELECT pg_temp.try('task_check: «замечание» с комментарием', 'ok', $$UPDATE task_check SET result = 'deviation', comment = 'Нет сигнала', checked_at = now(), checked_by_id = 3 WHERE id = 1$$);
SELECT pg_temp.try('task_check: результат без автора и времени', 'fail', $$UPDATE task_check SET result = 'passed' WHERE id = 1$$);
SELECT pg_temp.try('task_check: автор без результата', 'fail', $$UPDATE task_check SET checked_by_id = 3 WHERE id = 1$$);
SELECT pg_temp.try('task_check: пустой черновик допустим', 'ok', $$UPDATE task_check SET comment = 'черновик' WHERE id = 1$$);

-- ---------- История ----------
SELECT pg_temp.try('status_history: первая запись не «Создано»', 'fail', $$INSERT INTO task_status_history (task_id, previous_status, new_status) VALUES (2, NULL, 'assigned')$$);
SELECT pg_temp.try('status_history: запись планировщика без автора', 'ok', $$INSERT INTO task_status_history (task_id, previous_status, new_status) VALUES (2, NULL, 'created')$$);
SELECT pg_temp.try('status_history: тот же статус', 'fail', $$INSERT INTO task_status_history (task_id, previous_status, new_status, changed_by_id) VALUES (1, 'created', 'created', 2)$$);
SELECT pg_temp.try('status_history: возврат без комментария', 'fail', $$INSERT INTO task_status_history (task_id, previous_status, new_status, changed_by_id) VALUES (1, 'in_review', 'rework', 2)$$);
SELECT pg_temp.try('status_history: отмена без причины', 'fail', $$INSERT INTO task_status_history (task_id, previous_status, new_status, changed_by_id) VALUES (1, 'created', 'cancelled', 2)$$);
SELECT pg_temp.try('status_history: отмена с причиной', 'ok', $$INSERT INTO task_status_history (task_id, previous_status, new_status, changed_by_id, comment) VALUES (1, 'created', 'cancelled', 2, 'причина')$$);
SELECT pg_temp.try('status_history: запись нельзя изменить', 'fail', $$UPDATE task_status_history SET comment = 'x' WHERE id = 1$$);
SELECT pg_temp.try('status_history: запись нельзя удалить', 'fail', $$DELETE FROM task_status_history WHERE id = 1$$);
SELECT pg_temp.try('deadline: тот же срок', 'fail', $$INSERT INTO task_deadline_change (task_id, changed_by_id, previous_due_date, new_due_date, reason) VALUES (1, 2, '2026-11-01', '2026-11-01', 'x')$$);
SELECT pg_temp.try('deadline: без причины', 'fail', $$INSERT INTO task_deadline_change (task_id, changed_by_id, previous_due_date, new_due_date, reason) VALUES (1, 2, '2026-11-01', '2026-11-02', ' ')$$);
SELECT pg_temp.try('deadline: запись нельзя изменить', 'fail', $q$INSERT INTO task_deadline_change (task_id, changed_by_id, previous_due_date, new_due_date, reason) VALUES (1, 2, '2026-11-01', '2026-11-02', 'x'); UPDATE task_deadline_change SET reason = 'y'$q$);
SELECT pg_temp.try('assignment: назначение без прежнего инженера', 'ok', $$INSERT INTO task_assignment_history (task_id, previous_engineer_id, new_engineer_id, changed_by_id) VALUES (1, NULL, 3, 2)$$);
SELECT pg_temp.try('assignment: замена инженера', 'ok', $$INSERT INTO task_assignment_history (task_id, previous_engineer_id, new_engineer_id, changed_by_id) VALUES (1, 3, 4, 2)$$);
SELECT pg_temp.try('assignment: тот же инженер', 'fail', $$INSERT INTO task_assignment_history (task_id, previous_engineer_id, new_engineer_id, changed_by_id) VALUES (1, 3, 3, 2)$$);
SELECT pg_temp.try('assignment: без нового инженера', 'fail', $$INSERT INTO task_assignment_history (task_id, previous_engineer_id, new_engineer_id, changed_by_id) VALUES (1, 3, NULL, 2)$$);
SELECT pg_temp.try('assignment: запись нельзя удалить', 'fail', $$INSERT INTO task_assignment_history (task_id, previous_engineer_id, new_engineer_id, changed_by_id) VALUES (1, NULL, 3, 2); DELETE FROM task_assignment_history$$);

-- ---------- Отчёт ----------
SELECT pg_temp.try('report: просроченное задание в статусе «Создано»', 'ok', $q$INSERT INTO maintenance_task (regulation_id, system_id, original_due_date, current_due_date) VALUES (1, 1, '2020-01-01', '2020-01-01'); DO $x$ BEGIN IF NOT (SELECT is_overdue AND has_deadline_violation FROM v_task_report WHERE original_due_date = '2020-01-01') THEN RAISE EXCEPTION 'не просрочено'; END IF; END $x$$q$);
SELECT pg_temp.try('report: «На проверке» не считается просрочкой', 'ok', $q$UPDATE maintenance_task SET current_due_date = '2020-01-01', original_due_date = original_due_date WHERE id = 2 AND false; INSERT INTO maintenance_task (regulation_id, system_id, original_due_date, current_due_date, status, assigned_engineer_id, started_at, submitted_at, actual_performed_on) VALUES (1, 1, '2020-02-01', '2020-02-01', 'in_review', 3, now(), now(), '2020-02-01'); DO $x$ BEGIN IF (SELECT is_overdue FROM v_task_report WHERE original_due_date = '2020-02-01') THEN RAISE EXCEPTION 'просрочено'; END IF; END $x$$q$);
SELECT pg_temp.try('report: отменённое не в просрочке, нарушение срока сохраняется', 'ok', $q$INSERT INTO maintenance_task (regulation_id, system_id, original_due_date, current_due_date) VALUES (1, 1, '2020-03-01', '2020-03-10'); INSERT INTO task_deadline_change (task_id, changed_by_id, previous_due_date, new_due_date, reason) SELECT id, 2, '2020-03-01', '2020-03-10', 'после истечения' FROM maintenance_task WHERE original_due_date = '2020-03-01'; UPDATE maintenance_task SET status = 'cancelled', cancelled_at = now(), cancelled_by_id = 2, cancellation_reason = 'x' WHERE original_due_date = '2020-03-01'; DO $x$ BEGIN IF (SELECT is_overdue OR NOT has_deadline_violation FROM v_task_report WHERE original_due_date = '2020-03-01') THEN RAISE EXCEPTION 'неверно'; END IF; END $x$$q$);
SELECT pg_temp.try('report: срок в будущем - не просрочка', 'ok', $q$INSERT INTO maintenance_task (regulation_id, system_id, original_due_date, current_due_date) VALUES (1, 1, '2099-01-01', '2099-01-01'); DO $x$ BEGIN IF (SELECT is_overdue OR has_deadline_violation FROM v_task_report WHERE original_due_date = '2099-01-01') THEN RAISE EXCEPTION 'просрочено'; END IF; END $x$$q$);

-- ---------- Сессии ----------
SELECT pg_temp.try('sessions: валидная сессия', 'ok', $$INSERT INTO sessions (token_hash, user_id, csrf_token) VALUES ('h1', 3, 'c1')$$);
SELECT pg_temp.try('sessions: дубль токена', 'fail', $$INSERT INTO sessions (token_hash, user_id, csrf_token) VALUES ('h1', 3, 'c1'); INSERT INTO sessions (token_hash, user_id, csrf_token) VALUES ('h1', 4, 'c2')$$);
SELECT pg_temp.try('sessions: несуществующий пользователь', 'fail', $$INSERT INTO sessions (token_hash, user_id, csrf_token) VALUES ('h2', 999, 'c1')$$);
SELECT pg_temp.try('sessions: без csrf-токена', 'fail', $$INSERT INTO sessions (token_hash, user_id) VALUES ('h3', 3)$$);
SELECT pg_temp.try('sessions: сброс сессий пользователя не трогает чужие', 'ok', $q$INSERT INTO sessions (token_hash, user_id, csrf_token) VALUES ('h4', 3, 'c'), ('h5', 3, 'c'), ('h6', 4, 'c'); DELETE FROM sessions WHERE user_id = 3; DO $x$ BEGIN IF (SELECT count(*) FROM sessions WHERE user_id = 3) <> 0 OR (SELECT count(*) FROM sessions WHERE user_id = 4) <> 1 THEN RAISE EXCEPTION 'не то удалено'; END IF; END $x$$q$);
SELECT pg_temp.try('sessions: удаление пользователя удаляет его сессии', 'ok', $q$INSERT INTO users (login, password_hash, full_name, role) VALUES ('tmp', 'h', 'T', 'engineer'); INSERT INTO sessions (token_hash, user_id, csrf_token) SELECT 'tmp1', id, 'c' FROM users WHERE login = 'tmp'; DELETE FROM users WHERE login = 'tmp'; DO $x$ BEGIN IF EXISTS (SELECT 1 FROM sessions WHERE token_hash = 'tmp1') THEN RAISE EXCEPTION 'сессия осталась'; END IF; END $x$$q$);

\echo
\echo === ИТОГ ===
SELECT count(*) FILTER (WHERE ok) AS passed, count(*) FILTER (WHERE NOT ok) AS failed, count(*) AS total FROM results;
\echo
\echo === Расхождения ===
SELECT label, expected AS "ожидали", got AS "получили" FROM results WHERE NOT ok;
