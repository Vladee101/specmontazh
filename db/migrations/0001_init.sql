-- =====================================================================
-- Модуль контроля ТО слаботочных систем. Схема БД по ТЗ MVP 1.2 (24.10.2026)
-- PostgreSQL 14+. 13 доменных таблиц из model_mvp.json + служебная sessions.
-- Даты сроков - тип date (без времени); события - timestamptz (UTC).
-- Технические добавки к ERD заказчика (допускаются ТЗ): version (оптимистичная
-- блокировка), последовательность task_number, представление отчёта.
-- Схема БД является источником истины: код подстраивается под неё.
-- =====================================================================

-- ---------- Общие функции ----------

CREATE FUNCTION trg_bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.version := OLD.version + 1;
    RETURN NEW;
END $$;

CREATE FUNCTION trg_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'таблица % допускает только добавление записей', TG_TABLE_NAME
        USING ERRCODE = '23514';
END $$;

-- ---------- Пользователи ----------

CREATE TABLE users (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    login         text        NOT NULL,
    password_hash text        NOT NULL,
    full_name     text        NOT NULL,
    role          text        NOT NULL,
    is_active     boolean     NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    version       integer     NOT NULL DEFAULT 1,
    CONSTRAINT users_login_ck CHECK (btrim(login) <> '' AND login = btrim(login)),
    CONSTRAINT users_hash_ck  CHECK (password_hash <> ''),
    CONSTRAINT users_name_ck  CHECK (btrim(full_name) <> ''),
    CONSTRAINT users_role_ck  CHECK (role IN ('admin', 'manager', 'engineer'))
);
CREATE UNIQUE INDEX users_login_uq ON users (lower(login));
CREATE TRIGGER users_version BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION trg_bump_version();

-- ---------- Объекты, системы, оборудование ----------

CREATE TABLE service_object (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_by_id bigint      NOT NULL REFERENCES users (id),
    name          text        NOT NULL,
    customer_name text        NOT NULL,
    address       text        NOT NULL,
    contact_name  text,
    contact_phone text,
    notes         text,
    is_archived   boolean     NOT NULL DEFAULT false,
    archived_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    version       integer     NOT NULL DEFAULT 1,
    CONSTRAINT object_name_ck     CHECK (btrim(name) <> ''),
    CONSTRAINT object_customer_ck CHECK (btrim(customer_name) <> ''),
    CONSTRAINT object_address_ck  CHECK (btrim(address) <> ''),
    CONSTRAINT object_archive_ck  CHECK (is_archived = (archived_at IS NOT NULL))
);
CREATE INDEX object_created_by_idx ON service_object (created_by_id);
CREATE INDEX object_active_name_idx ON service_object (name) WHERE NOT is_archived;
CREATE TRIGGER object_version BEFORE UPDATE ON service_object FOR EACH ROW EXECUTE FUNCTION trg_bump_version();

CREATE TABLE low_current_system (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    object_id   bigint  NOT NULL REFERENCES service_object (id),
    name        text    NOT NULL,
    system_type text    NOT NULL,
    location    text,
    description text,
    is_archived boolean NOT NULL DEFAULT false,
    archived_at timestamptz,
    version     integer NOT NULL DEFAULT 1,
    CONSTRAINT system_name_ck    CHECK (btrim(name) <> ''),
    CONSTRAINT system_type_ck    CHECK (system_type IN ('fire_alarm', 'evacuation_alert', 'security_alarm', 'video_surveillance')),
    CONSTRAINT system_archive_ck CHECK (is_archived = (archived_at IS NOT NULL))
);
CREATE INDEX system_object_idx ON low_current_system (object_id);
CREATE TRIGGER system_version BEFORE UPDATE ON low_current_system FOR EACH ROW EXECUTE FUNCTION trg_bump_version();

CREATE TABLE equipment (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    system_id           bigint  NOT NULL REFERENCES low_current_system (id),
    name                text    NOT NULL,
    equipment_type      text    NOT NULL,
    model               text,
    serial_number       text,
    location            text,
    installed_on        date,
    lifecycle_status    text    NOT NULL DEFAULT 'active',
    decommissioned_on   date,
    decommission_reason text,
    version             integer NOT NULL DEFAULT 1,
    CONSTRAINT equipment_name_ck   CHECK (btrim(name) <> ''),
    CONSTRAINT equipment_type_ck   CHECK (btrim(equipment_type) <> ''),
    CONSTRAINT equipment_status_ck CHECK (lifecycle_status IN ('active', 'decommissioned')),
    CONSTRAINT equipment_decom_ck  CHECK (
        (lifecycle_status = 'active'
            AND decommissioned_on IS NULL AND decommission_reason IS NULL)
        OR (lifecycle_status = 'decommissioned'
            AND decommissioned_on IS NOT NULL AND btrim(coalesce(decommission_reason, '')) <> '')
    ),
    CONSTRAINT equipment_dates_ck  CHECK (installed_on IS NULL OR decommissioned_on IS NULL OR decommissioned_on >= installed_on)
);
CREATE INDEX equipment_system_idx ON equipment (system_id);
CREATE INDEX equipment_system_active_idx ON equipment (system_id) WHERE lifecycle_status = 'active';
CREATE TRIGGER equipment_version BEFORE UPDATE ON equipment FOR EACH ROW EXECUTE FUNCTION trg_bump_version();

-- ---------- Шаблоны чек-листов ----------

CREATE TABLE checklist_template (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text    NOT NULL,
    system_type text    NOT NULL,
    is_active   boolean NOT NULL DEFAULT true,
    version     integer NOT NULL DEFAULT 1,
    CONSTRAINT template_name_ck CHECK (btrim(name) <> ''),
    CONSTRAINT template_type_ck CHECK (system_type IN ('fire_alarm', 'evacuation_alert', 'security_alarm', 'video_surveillance')),
    CONSTRAINT template_type_uq UNIQUE (system_type)
);
CREATE TRIGGER template_version BEFORE UPDATE ON checklist_template FOR EACH ROW EXECUTE FUNCTION trg_bump_version();

CREATE TABLE template_item (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    template_id           bigint  NOT NULL REFERENCES checklist_template (id) ON DELETE CASCADE,
    position              integer NOT NULL,
    section_name          text,
    check_text            text    NOT NULL,
    target_type           text    NOT NULL,
    equipment_type_filter jsonb,
    is_required           boolean NOT NULL DEFAULT true,
    CONSTRAINT titem_position_ck CHECK (position > 0),
    CONSTRAINT titem_text_ck     CHECK (btrim(check_text) <> ''),
    CONSTRAINT titem_target_ck   CHECK (target_type IN ('system', 'equipment')),
    -- фильтр по типам оборудования: только для пунктов по оборудованию, непустой массив
    CONSTRAINT titem_filter_ck   CHECK (
        equipment_type_filter IS NULL
        OR (target_type = 'equipment'
            AND jsonb_typeof(equipment_type_filter) = 'array'
            AND jsonb_array_length(equipment_type_filter) > 0)
    ),
    CONSTRAINT titem_position_uq UNIQUE (template_id, position)
);

-- ---------- Регламенты ----------

CREATE TABLE maintenance_regulation (
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    system_id            bigint  NOT NULL REFERENCES low_current_system (id),
    template_id          bigint  NOT NULL REFERENCES checklist_template (id),
    created_by_id        bigint  NOT NULL REFERENCES users (id),
    name                 text    NOT NULL,
    interval_value       integer NOT NULL,
    interval_unit        text    NOT NULL DEFAULT 'month',
    schedule_anchor_date date    NOT NULL,
    next_due_date        date    NOT NULL,
    status               text    NOT NULL DEFAULT 'draft',
    paused_at            timestamptz,
    activated_at         timestamptz,
    version              integer NOT NULL DEFAULT 1,
    CONSTRAINT reg_name_ck     CHECK (btrim(name) <> ''),
    CONSTRAINT reg_interval_ck CHECK (interval_value > 0),
    CONSTRAINT reg_unit_ck     CHECK (interval_unit IN ('month')),
    CONSTRAINT reg_status_ck   CHECK (status IN ('draft', 'active', 'paused')),
    CONSTRAINT reg_state_ck    CHECK (
        (status = 'draft'  AND activated_at IS NULL     AND paused_at IS NULL)
        OR (status = 'active' AND activated_at IS NOT NULL AND paused_at IS NULL)
        OR (status = 'paused' AND activated_at IS NOT NULL AND paused_at IS NOT NULL)
    ),
    CONSTRAINT reg_next_ck     CHECK (next_due_date >= schedule_anchor_date),
    CONSTRAINT reg_id_system_uq UNIQUE (id, system_id)
);
CREATE INDEX reg_system_idx ON maintenance_regulation (system_id);
CREATE INDEX reg_template_idx ON maintenance_regulation (template_id);
CREATE INDEX reg_created_by_idx ON maintenance_regulation (created_by_id);
CREATE INDEX reg_scheduler_idx ON maintenance_regulation (next_due_date) WHERE status = 'active';
CREATE TRIGGER reg_version BEFORE UPDATE ON maintenance_regulation FOR EACH ROW EXECUTE FUNCTION trg_bump_version();

-- ---------- Задания ----------

CREATE SEQUENCE task_number_seq;

CREATE TABLE maintenance_task (
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    regulation_id        bigint  NOT NULL,
    system_id            bigint  NOT NULL,
    assigned_engineer_id bigint  REFERENCES users (id),
    reviewed_by_id       bigint  REFERENCES users (id),
    cancelled_by_id      bigint  REFERENCES users (id),
    task_number          text    NOT NULL DEFAULT ('ТО-' || lpad(nextval('task_number_seq')::text, 6, '0')),
    status               text    NOT NULL DEFAULT 'created',
    original_due_date    date    NOT NULL,
    current_due_date     date    NOT NULL,
    actual_performed_on  date,
    started_at           timestamptz,
    submitted_at         timestamptz,
    accepted_at          timestamptz,
    is_partial           boolean NOT NULL DEFAULT false,
    engineer_comment     text,
    review_comment       text,
    cancelled_at         timestamptz,
    cancellation_reason  text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    version              integer NOT NULL DEFAULT 1,
    -- задание принадлежит той же системе, что и регламент
    CONSTRAINT task_regulation_fk FOREIGN KEY (regulation_id, system_id)
        REFERENCES maintenance_regulation (id, system_id),
    CONSTRAINT task_system_fk FOREIGN KEY (system_id) REFERENCES low_current_system (id),
    CONSTRAINT task_number_uq UNIQUE (task_number),
    CONSTRAINT task_number_ck CHECK (task_number ~ '^ТО-[0-9]{6,}$'),
    -- исходный срок уникален в рамках регламента, в том числе для отменённых (нет дублей после отмены)
    CONSTRAINT task_regulation_date_uq UNIQUE (regulation_id, original_due_date),
    CONSTRAINT task_status_ck CHECK (status IN ('created', 'assigned', 'in_progress', 'in_review', 'rework', 'accepted', 'cancelled')),
    CONSTRAINT task_engineer_ck CHECK (
        (status = 'created' AND assigned_engineer_id IS NULL)
        OR status = 'cancelled'
        OR (status IN ('assigned', 'in_progress', 'in_review', 'rework', 'accepted') AND assigned_engineer_id IS NOT NULL)
    ),
    CONSTRAINT task_started_ck CHECK (
        status NOT IN ('in_progress', 'in_review', 'rework', 'accepted') OR started_at IS NOT NULL
    ),
    CONSTRAINT task_submitted_ck CHECK (
        status NOT IN ('in_review', 'accepted') OR (submitted_at IS NOT NULL AND actual_performed_on IS NOT NULL)
    ),
    CONSTRAINT task_accepted_ck CHECK (
        (status = 'accepted' AND accepted_at IS NOT NULL AND reviewed_by_id IS NOT NULL AND NOT is_partial)
        OR (status <> 'accepted' AND accepted_at IS NULL)
    ),
    CONSTRAINT task_rework_ck CHECK (
        status <> 'rework' OR btrim(coalesce(review_comment, '')) <> ''
    ),
    CONSTRAINT task_cancel_ck CHECK (
        (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_id IS NOT NULL
            AND btrim(coalesce(cancellation_reason, '')) <> '')
        OR (status <> 'cancelled' AND cancelled_at IS NULL AND cancelled_by_id IS NULL AND cancellation_reason IS NULL)
    )
);
CREATE INDEX task_status_due_idx ON maintenance_task (status, current_due_date);
CREATE INDEX task_open_due_idx ON maintenance_task (current_due_date)
    WHERE status IN ('created', 'assigned', 'in_progress', 'rework');
CREATE INDEX task_engineer_idx ON maintenance_task (assigned_engineer_id, status);
CREATE INDEX task_original_due_idx ON maintenance_task (original_due_date);
CREATE INDEX task_system_idx ON maintenance_task (system_id);
CREATE INDEX task_reviewed_by_idx ON maintenance_task (reviewed_by_id) WHERE reviewed_by_id IS NOT NULL;
CREATE INDEX task_cancelled_by_idx ON maintenance_task (cancelled_by_id) WHERE cancelled_by_id IS NOT NULL;

CREATE TRIGGER task_version BEFORE UPDATE ON maintenance_task FOR EACH ROW EXECUTE FUNCTION trg_bump_version();

-- Неизменяемые поля и допустимые переходы статуса
CREATE FUNCTION trg_task_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.regulation_id <> OLD.regulation_id OR NEW.system_id <> OLD.system_id
       OR NEW.original_due_date <> OLD.original_due_date
       OR NEW.task_number <> OLD.task_number OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'поля regulation_id, system_id, original_due_date, task_number, created_at не изменяются'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
        (OLD.status, NEW.status) IN (
            ('created', 'assigned'), ('assigned', 'in_progress'),
            ('in_progress', 'in_review'), ('rework', 'in_review'),
            ('in_review', 'accepted'), ('in_review', 'rework'))
        OR (NEW.status = 'cancelled' AND OLD.status NOT IN ('accepted', 'cancelled'))
    ) THEN
        RAISE EXCEPTION 'недопустимый переход статуса % -> %', OLD.status, NEW.status
            USING ERRCODE = '23514';
    END IF;
    IF OLD.status IN ('accepted', 'cancelled') AND NEW.current_due_date <> OLD.current_due_date THEN
        RAISE EXCEPTION 'срок принятого или отменённого задания не меняется' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER task_guard BEFORE UPDATE ON maintenance_task FOR EACH ROW EXECUTE FUNCTION trg_task_guard();

-- Состав оборудования задания

CREATE TABLE task_equipment (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id      bigint NOT NULL REFERENCES maintenance_task (id),
    equipment_id bigint NOT NULL REFERENCES equipment (id),
    CONSTRAINT task_equipment_uq UNIQUE (task_id, equipment_id),
    CONSTRAINT task_equipment_task_id_uq UNIQUE (task_id, id)
);
CREATE INDEX task_equipment_equipment_idx ON task_equipment (equipment_id);

CREATE FUNCTION trg_task_equipment_same_system() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM maintenance_task t JOIN equipment e ON e.system_id = t.system_id
        WHERE t.id = NEW.task_id AND e.id = NEW.equipment_id
    ) THEN
        RAISE EXCEPTION 'оборудование не принадлежит системе задания' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER task_equipment_system BEFORE INSERT OR UPDATE ON task_equipment
    FOR EACH ROW EXECUTE FUNCTION trg_task_equipment_same_system();

-- Копии пунктов проверки (текст и признак обязательности фиксируются при создании задания)

CREATE TABLE task_check (
    id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id                 bigint  NOT NULL REFERENCES maintenance_task (id),
    task_equipment_id       bigint,
    source_template_item_id bigint  REFERENCES template_item (id) ON DELETE SET NULL,
    checked_by_id           bigint  REFERENCES users (id),
    position                integer NOT NULL,
    section_name            text,
    check_text              text    NOT NULL,
    is_required             boolean NOT NULL,
    result                  text,
    comment                 text,
    checked_at              timestamptz,
    -- элемент оборудования должен принадлежать тому же заданию
    CONSTRAINT task_check_equipment_fk FOREIGN KEY (task_id, task_equipment_id)
        REFERENCES task_equipment (task_id, id),
    CONSTRAINT task_check_text_ck   CHECK (btrim(check_text) <> ''),
    CONSTRAINT task_check_pos_ck    CHECK (position > 0),
    CONSTRAINT task_check_result_ck CHECK (result IS NULL OR result IN ('passed', 'deviation', 'not_applicable', 'not_checked')),
    -- комментарий обязателен для всех результатов, кроме «норма»
    CONSTRAINT task_check_comment_ck CHECK (
        result IS NULL OR result = 'passed' OR btrim(coalesce(comment, '')) <> ''
    ),
    CONSTRAINT task_check_filled_ck CHECK (
        (result IS NULL AND checked_at IS NULL AND checked_by_id IS NULL)
        OR (result IS NOT NULL AND checked_at IS NOT NULL AND checked_by_id IS NOT NULL)
    )
);
CREATE INDEX task_check_task_idx ON task_check (task_id, position);
CREATE INDEX task_check_equipment_idx ON task_check (task_equipment_id) WHERE task_equipment_id IS NOT NULL;
CREATE INDEX task_check_source_idx ON task_check (source_template_item_id) WHERE source_template_item_id IS NOT NULL;
CREATE INDEX task_check_checked_by_idx ON task_check (checked_by_id) WHERE checked_by_id IS NOT NULL;

-- ---------- История (только добавление) ----------

CREATE TABLE task_deadline_change (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id           bigint      NOT NULL REFERENCES maintenance_task (id),
    changed_by_id     bigint      NOT NULL REFERENCES users (id),
    previous_due_date date        NOT NULL,
    new_due_date      date        NOT NULL,
    reason            text        NOT NULL,
    changed_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT deadline_diff_ck   CHECK (new_due_date <> previous_due_date),
    CONSTRAINT deadline_reason_ck CHECK (btrim(reason) <> '')
);
CREATE INDEX deadline_task_idx ON task_deadline_change (task_id, changed_at);
CREATE INDEX deadline_user_idx ON task_deadline_change (changed_by_id);

CREATE TABLE task_assignment_history (
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id              bigint      NOT NULL REFERENCES maintenance_task (id),
    previous_engineer_id bigint      REFERENCES users (id),
    new_engineer_id      bigint      NOT NULL REFERENCES users (id),
    changed_by_id        bigint      NOT NULL REFERENCES users (id),
    changed_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT assignment_diff_ck CHECK (previous_engineer_id IS DISTINCT FROM new_engineer_id)
);
CREATE INDEX assignment_task_idx ON task_assignment_history (task_id, changed_at);
CREATE INDEX assignment_prev_idx ON task_assignment_history (previous_engineer_id) WHERE previous_engineer_id IS NOT NULL;
CREATE INDEX assignment_new_idx ON task_assignment_history (new_engineer_id);
CREATE INDEX assignment_user_idx ON task_assignment_history (changed_by_id);

CREATE TABLE task_status_history (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id             bigint      NOT NULL REFERENCES maintenance_task (id),
    changed_by_id       bigint      REFERENCES users (id),  -- NULL: действие планировщика (создание задания)
    previous_status     text,                                -- NULL: первая запись
    new_status          text        NOT NULL,
    comment             text,
    actual_performed_on date,
    changed_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT status_hist_new_ck  CHECK (new_status IN ('created', 'assigned', 'in_progress', 'in_review', 'rework', 'accepted', 'cancelled')),
    CONSTRAINT status_hist_prev_ck CHECK (previous_status IS NULL OR previous_status IN ('created', 'assigned', 'in_progress', 'in_review', 'rework', 'accepted', 'cancelled')),
    CONSTRAINT status_hist_diff_ck CHECK (previous_status IS DISTINCT FROM new_status),
    CONSTRAINT status_hist_first_ck CHECK (previous_status IS NOT NULL OR new_status = 'created'),
    -- возврат на доработку и отмена - только с комментарием (причиной)
    CONSTRAINT status_hist_comment_ck CHECK (
        new_status NOT IN ('rework', 'cancelled') OR btrim(coalesce(comment, '')) <> ''
    )
);
CREATE INDEX status_hist_task_idx ON task_status_history (task_id, changed_at);
CREATE INDEX status_hist_user_idx ON task_status_history (changed_by_id) WHERE changed_by_id IS NOT NULL;

CREATE TRIGGER deadline_append_only    BEFORE UPDATE OR DELETE ON task_deadline_change    FOR EACH ROW EXECUTE FUNCTION trg_append_only();
CREATE TRIGGER assignment_append_only  BEFORE UPDATE OR DELETE ON task_assignment_history FOR EACH ROW EXECUTE FUNCTION trg_append_only();
CREATE TRIGGER status_hist_append_only BEFORE UPDATE OR DELETE ON task_status_history     FOR EACH ROW EXECUTE FUNCTION trg_append_only();

-- ---------- Межтабличные правила ----------

-- Тип системы нельзя менять, если у неё есть оборудование, регламенты или задания
CREATE FUNCTION trg_system_type_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.system_type <> OLD.system_type AND (
        EXISTS (SELECT 1 FROM equipment WHERE system_id = OLD.id)
        OR EXISTS (SELECT 1 FROM maintenance_regulation WHERE system_id = OLD.id)
        OR EXISTS (SELECT 1 FROM maintenance_task WHERE system_id = OLD.id)
    ) THEN
        RAISE EXCEPTION 'тип системы с оборудованием, регламентами или заданиями не меняется'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER system_type_guard BEFORE UPDATE OF system_type ON low_current_system
    FOR EACH ROW EXECUTE FUNCTION trg_system_type_guard();

-- Регламент: тип шаблона = тип системы; активация требует активного шаблона
-- с хотя бы одним пунктом и неархивных системы и объекта
CREATE FUNCTION trg_regulation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    sys_type text; sys_arch boolean; obj_arch boolean;
    tpl_type text; tpl_active boolean;
BEGIN
    SELECT s.system_type, s.is_archived, o.is_archived INTO sys_type, sys_arch, obj_arch
      FROM low_current_system s JOIN service_object o ON o.id = s.object_id WHERE s.id = NEW.system_id;
    SELECT system_type, is_active INTO tpl_type, tpl_active FROM checklist_template WHERE id = NEW.template_id;
    IF sys_type <> tpl_type THEN
        RAISE EXCEPTION 'тип шаблона не совпадает с типом системы' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status <> 'active') THEN
        IF NOT tpl_active THEN
            RAISE EXCEPTION 'шаблон неактивен' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM template_item WHERE template_id = NEW.template_id) THEN
            RAISE EXCEPTION 'в шаблоне нет пунктов' USING ERRCODE = '23514';
        END IF;
        IF sys_arch OR obj_arch THEN
            RAISE EXCEPTION 'система или объект в архиве' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER regulation_guard BEFORE INSERT OR UPDATE ON maintenance_regulation
    FOR EACH ROW EXECUTE FUNCTION trg_regulation_guard();

-- ---------- Отчёт (общая выборка для таблицы и CSV) ----------
-- Просрочка считается по московскому календарному дню; «На проверке» просрочкой не является.
-- has_deadline_violation (предложение, требует подтверждения заказчика): просрочено сейчас,
-- либо срок переносили после его истечения, либо работа выполнена позже действующего срока.

CREATE VIEW v_task_report AS
SELECT
    t.id, t.task_number, t.status, t.original_due_date, t.current_due_date,
    t.actual_performed_on, t.accepted_at, t.is_partial, t.engineer_comment, t.review_comment,
    t.cancellation_reason, t.assigned_engineer_id,
    o.id AS object_id, o.name AS object_name, o.customer_name, o.address,
    s.id AS system_id, s.name AS system_name, s.system_type,
    u.full_name AS engineer_name,
    od.overdue AS is_overdue,
    (od.overdue
        OR EXISTS (SELECT 1 FROM task_deadline_change d
                   WHERE d.task_id = t.id
                     AND d.previous_due_date < (d.changed_at AT TIME ZONE 'Europe/Moscow')::date)
        OR (t.status IN ('in_review', 'accepted') AND t.actual_performed_on > t.current_due_date)
    ) AS has_deadline_violation
FROM maintenance_task t
JOIN low_current_system s ON s.id = t.system_id
JOIN service_object o ON o.id = s.object_id
LEFT JOIN users u ON u.id = t.assigned_engineer_id
CROSS JOIN LATERAL (
    SELECT t.status IN ('created', 'assigned', 'in_progress', 'rework')
           AND t.current_due_date < (now() AT TIME ZONE 'Europe/Moscow')::date AS overdue
) od;

-- ---------- Сессии (служебная таблица, вне ERD заказчика) ----------

CREATE TABLE sessions (
    token_hash   text        PRIMARY KEY,
    user_id      bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    csrf_token   text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_last_seen_idx ON sessions (last_seen_at);
