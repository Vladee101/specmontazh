#!/usr/bin/env bash
# Резервная копия БД sm_to в формате pg_dump custom (-Fc).
# Запускается таймером sm-to-backup.timer от пользователя smto
# (вход в PostgreSQL по peer-аутентификации, пароль не нужен).
set -euo pipefail

DIR=/var/backups/sm-to
KEEP_DAYS="${KEEP_DAYS:-14}"
file="$DIR/sm_to_$(date +%F_%H%M).dump"

pg_dump -Fc -d sm_to -f "$file.tmp"
mv "$file.tmp" "$file"

find "$DIR" -name 'sm_to_*.dump' -mtime +"$KEEP_DAYS" -delete

echo "backup ok: $file ($(du -h "$file" | cut -f1))"
