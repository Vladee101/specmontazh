#!/usr/bin/env bash
# Проверка восстановления: разворачивает копию во временную БД,
# выводит число строк в основных таблицах и удаляет временную БД.
# Запуск от root: ./restore-check.sh /var/backups/sm-to/sm_to_2026-11-01_0330.dump
set -euo pipefail

dump="${1:?укажите файл копии}"
db=sm_to_restore_check

sudo -u postgres dropdb --if-exists "$db"
sudo -u postgres createdb -O smto "$db"
sudo -u postgres pg_restore --no-owner --role=smto -d "$db" "$dump"

sudo -u postgres psql -d "$db" -v ON_ERROR_STOP=1 -c "
SELECT 'users' AS tbl, count(*) FROM users
UNION ALL SELECT 'service_object', count(*) FROM service_object
UNION ALL SELECT 'equipment', count(*) FROM equipment
UNION ALL SELECT 'maintenance_regulation', count(*) FROM maintenance_regulation
UNION ALL SELECT 'maintenance_task', count(*) FROM maintenance_task
UNION ALL SELECT 'task_check', count(*) FROM task_check;"

sudo -u postgres dropdb "$db"
echo "restore ok: $dump"
