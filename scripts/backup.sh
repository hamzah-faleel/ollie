#!/bin/sh
# Daily local backup of the wa-bot data volume: a verified snapshot of bot.db plus the notes vault, as one .tgz.
# Safe by design: consistent database copy (VACUUM INTO) checked with integrity_check; the vault's .git (sync token) is left out;
# written to a temp file, checked, then renamed; files are 600 in a 700 folder; old backups are pruned.
# Cron (host):  15 1 * * * /home/ubuntu/OpenWA/wa-bot/scripts/backup.sh >> /home/ubuntu/backups/wa-bot/backup.log 2>&1
# Restore:      see the comment at the end of this file.
set -eu
umask 077
DIR="${BACKUP_DIR:-$HOME/backups/wa-bot}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
MIN_FREE_MB="${BACKUP_MIN_FREE_MB:-2048}"
STAMP="$(date -u +%Y-%m-%dT%H%MZ)"
OUT="$DIR/wa-bot-$STAMP.tgz"
TMP="$DIR/.partial-$STAMP.tgz"

mkdir -p "$DIR"; chmod 700 "$DIR"
cleanup() { rm -f "$TMP"; docker exec wa-bot rm -rf /tmp/bk >/dev/null 2>&1 || true; }
trap cleanup EXIT

free_mb="$(df -Pm "$DIR" | awk 'NR==2 {print $4}')"
if [ "$free_mb" -lt "$MIN_FREE_MB" ]; then echo "$(date -u +%FT%TZ) SKIPPED: only ${free_mb} MB free"; exit 1; fi

docker exec wa-bot node --disable-warning=ExperimentalWarning /app/backup.js
docker exec wa-bot tar czf - -C /tmp/bk . > "$TMP"

# verify before keeping: readable archive that contains the database and the vault
tar tzf "$TMP" > /dev/null
tar tzf "$TMP" | grep -q '^\./bot\.db$' || { echo "$(date -u +%FT%TZ) FAILED: bot.db missing from archive"; exit 1; }
tar tzf "$TMP" | grep -q '^\./vault/' || { echo "$(date -u +%FT%TZ) FAILED: vault missing from archive"; exit 1; }
[ "$(wc -c < "$TMP")" -gt 10000 ] || { echo "$(date -u +%FT%TZ) FAILED: archive suspiciously small"; exit 1; }

mv "$TMP" "$OUT"; chmod 600 "$OUT"
find "$DIR" -maxdepth 1 -name 'wa-bot-*.tgz' -mtime +"$KEEP_DAYS" -delete
echo "$(date -u +%FT%TZ) OK $(basename "$OUT") $(du -h "$OUT" | cut -f1), $(find "$DIR" -maxdepth 1 -name 'wa-bot-*.tgz' | wc -l) kept"

# RESTORE (stop the bot first so nothing writes while you copy):
#   docker compose stop wa-bot
#   mkdir /tmp/restore && tar xzf ~/backups/wa-bot/wa-bot-<stamp>.tgz -C /tmp/restore
#   docker run --rm -v openwa_wa-bot-data:/data -v /tmp/restore:/r alpine sh -c 'cp /r/bot.db /data/bot.db && rm -f /data/bot.db-wal /data/bot.db-shm && cp -r /r/vault/. /data/vault/ && chown -R 1000:1000 /data'
#   docker compose up -d --no-deps wa-bot
