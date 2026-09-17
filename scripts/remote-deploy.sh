#!/usr/bin/env bash
# Runs on the VM. deploy.sh uploads and starts it — you don't run this by hand.
#
#   remote-deploy.sh deploy <release-id> <tarball>   unpack, check, migrate, switch
#   remote-deploy.sh rollback [release-id]           switch back (default: the release live before this one)
#   remote-deploy.sh releases                        list what's on the server
#
# Settings arrive on stdin as KEY=VALUE lines ending with a blank line, so the database
# password never appears in a process list: DATABASE_URL, SKIP_PREFLIGHT, KEEP_RELEASES.
#
# Layout under $BASE (~/campus-event-api):
#   releases/<id>/     one directory per deploy, each with its own node_modules
#   current -> releases/<id>
#   shared/.env        bootstrap config (no secrets), linked into every release
#   shared/backups/    database dumps taken before migrations
#   shared/logs/       output of each release's pre-flight run
#   releases.log       each release that went live and passed its checks, and each failure,
#                      newest last — what `rollback` and pruning go by
set -euo pipefail

while IFS= read -r line && [ -n "$line" ]; do
  case "$line" in
    DATABASE_URL=*|SKIP_PREFLIGHT=*|KEEP_RELEASES=*) export "${line?}" ;;
  esac
done
exec </dev/null # nothing below should ever wait on input

BASE="${APP_BASE:-$HOME/campus-event-api}"
NAME="${APP_NAME:-campus-event-api}"
PORT="${APP_PORT:-3001}"
PREFLIGHT_PORT="${PREFLIGHT_PORT:-3002}"
KEEP="${KEEP_RELEASES:-5}"
RELEASES="$BASE/releases"
SHARED="$BASE/shared"
HISTORY="$BASE/releases.log"

say() { printf '   %s\n' "$*"; }
fail() { printf '\n❌ %s\n' "$*" >&2; exit 1; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
current_release() { if [ -L "$BASE/current" ]; then basename "$(readlink "$BASE/current")"; fi; }

# PM2 copies the caller's environment into the process (and into ~/.pm2/dump.pm2 on disk).
# The migration's DATABASE_URL must never end up there — the app reads it from Key Vault.
pm2_clean() { env -u DATABASE_URL pm2 "$@"; }

# ------------------------------------------------------------------------------ checks

# Waits until the app on $1 answers /health as release $2 and can reach the database.
# Releases from before this script existed (legacy-*) don't report a release id.
wait_healthy() {
  local port="$1" id="$2" seconds="$3" body
  for _ in $(seq 1 "$seconds"); do
    body="$(curl -fsS --max-time 2 "http://127.0.0.1:$port/health?deep=1" 2>/dev/null || true)"
    if [[ "$body" == *"\"release\":\"$id\""* && "$body" != *'"database":"unreachable"'* ]]; then return 0; fi
    if [[ "$id" == legacy-* && "$body" == *'"status":"ok"'* ]]; then return 0; fi
    sleep 1
  done
  say "No healthy answer from :$port as $id within ${seconds}s (last: ${body:-nothing})"
  return 1
}

# The frontend is served, and a real API route answers through the auth middleware.
smoke_test() {
  local port="$1" page api
  page="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/events/")"
  api="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/events/api/me")"
  if [ "$page" = 200 ] && [ "$api" = 401 ]; then return 0; fi
  say "Smoke test on :$port failed: /events/ → $page (want 200), /events/api/me → $api (want 401)"
  return 1
}

# Boots the release on a spare port, with the outbox worker off so it sends nothing, and
# checks it before any user is sent to it. Catches a release that crashes on start, is
# missing a dependency, or can't read its secrets — while the old release keeps serving.
preflight() {
  # Two `local`s: in one, $id in log= would expand before id is set (ShellCheck SC2318).
  local dir="$1" id="$2" pid ok=0
  local log="$SHARED/logs/$id-preflight.log"
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PREFLIGHT_PORT/"; then
    fail "Port $PREFLIGHT_PORT is already in use, so the pre-flight check can't run. Free it, or set PREFLIGHT_PORT."
  fi
  say "Pre-flight: starting $id on :$PREFLIGHT_PORT (users still on the current release)"
  # Only the node command is backgrounded, so $! is node itself. (`cd && node … &` would
  # background the whole list, and killing that subshell would leave node running.)
  (
    cd "$dir" || exit 1
    env -u DATABASE_URL PORT="$PREFLIGHT_PORT" OUTBOX_WORKER=off node src/server.js >"$log" 2>&1 &
    echo $! >"$SHARED/preflight.pid"
  )
  pid="$(cat "$SHARED/preflight.pid")"
  if wait_healthy "$PREFLIGHT_PORT" "$id" 45 && smoke_test "$PREFLIGHT_PORT"; then ok=1; fi
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$SHARED/preflight.pid"
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PREFLIGHT_PORT/"; then
    fail "The pre-flight copy of $id is still answering on :$PREFLIGHT_PORT after being stopped."
  fi
  if [ "$ok" = 1 ]; then say "Pre-flight passed"; return 0; fi
  say "Pre-flight log ($log):"
  tail -n 20 "$log" | sed 's/^/      /'
  return 1
}

# ------------------------------------------------------------------------------ database

# Migration folders in this release that the database hasn't applied yet.
pending_migrations() {
  local dir="$1"
  # shellcheck disable=SC2016 # JavaScript, not shell: nothing in it should expand
  (cd "$dir" && node -e '
    const fs = require("fs");
    const { PrismaClient } = require("@prisma/client");
    const local = fs.readdirSync("prisma/migrations").filter((d) => /^\d+_/.test(d)).sort();
    const prisma = new PrismaClient();
    prisma.$queryRawUnsafe("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
      .then((rows) => rows.map((r) => r.migration_name), () => [])   // no table yet: nothing applied
      .then((applied) => { console.log(local.filter((m) => !applied.includes(m)).join(" ")); return prisma.$disconnect(); });
  ')
}

# A full dump before anything changes the schema. Credentials go in a private temp file,
# not on the command line.
backup_database() {
  local id="$1" cnf db
  local file="$SHARED/backups/$id-before-migrate.sql.gz"
  mkdir -p "$SHARED/backups"
  cnf="$(mktemp)"
  chmod 600 "$cnf"
  # shellcheck disable=SC2016 # JavaScript, not shell: nothing in it should expand
  db="$(node -e '
    const u = new URL(process.env.DATABASE_URL);
    const esc = (s) => decodeURIComponent(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    require("fs").writeFileSync(process.argv[1], `[client]\nuser="${esc(u.username)}"\npassword="${esc(u.password)}"\nhost="${u.hostname}"\nport=${u.port || 3306}\n`);
    console.log(decodeURIComponent(u.pathname.slice(1)));
  ' "$cnf")"
  say "Backing up database '$db' to $file"
  if ! (umask 077 && mysqldump --defaults-extra-file="$cnf" --single-transaction --no-tablespaces "$db" | gzip >"$file"); then
    rm -f "$cnf" "$file"
    fail "The database backup failed, so no migration was run. Nothing has changed."
  fi
  rm -f "$cnf"
  # Keep the last 10 backups.
  # shellcheck disable=SC2012 # our own file names, no spaces or newlines
  ls -1t "$SHARED"/backups/*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
}

migrate() {
  local dir="$1" id="$2" pending
  [ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL wasn't passed — deploy.sh sends it for migrations"
  pending="$(pending_migrations "$dir")"
  if [ -z "$pending" ]; then
    say "No pending migrations"
    return
  fi
  say "Pending migrations: $pending"
  backup_database "$id"
  say "Applying migrations (the current release keeps running — migrations must stay compatible with it)"
  if ! (cd "$dir" && npx prisma migrate deploy >"$SHARED/logs/$id-migrate.log" 2>&1); then
    tail -n 20 "$SHARED/logs/$id-migrate.log" | sed 's/^/      /'
    rm -rf "$dir"
    echo "$(now) failed-migration $id" >>"$HISTORY"
    fail "A migration failed; the live release wasn't switched. If the database needs restoring: gunzip -c $SHARED/backups/$id-before-migrate.sql.gz | mysql <database>"
  fi
}

# ------------------------------------------------------------------------------ switching

# PM2 keeps the script path a process was started with, so switching releases means
# starting it again from the new directory — a restart would run the old code.
activate() {
  local id="$1" dir="$RELEASES/$1"
  [ -f "$dir/src/server.js" ] || fail "There's no release called $id"
  ln -sfn "releases/$id" "$BASE/current.next"
  mv -Tf "$BASE/current.next" "$BASE/current"
  pm2_clean delete "$NAME" >/dev/null 2>&1 || true
  pm2_clean start "$dir/src/server.js" --name "$NAME" --cwd "$dir" >/dev/null
  pm2_clean save >/dev/null
}

# Only a release that passed this is recorded as live — so `rollback` never picks one that
# went live and failed.
check_live() {
  if wait_healthy "$PORT" "$1" 60 && smoke_test "$PORT"; then
    echo "$(now) live $1" >>"$HISTORY"
    return 0
  fi
  echo "$(now) failed-live $1" >>"$HISTORY"
  return 1
}

# The release that was last live, and healthy, before the current one.
previous_release() {
  local current="$1" id
  [ -f "$HISTORY" ] || return 0
  while read -r _ state id; do
    if [ "$state" = live ] && [ "$id" != "$current" ] && [ -f "$RELEASES/$id/src/server.js" ]; then
      echo "$id"
      return 0
    fi
  done < <(tac "$HISTORY")
}

# Keeps the KEEP releases most recently live (the current one always among them) and removes
# the rest — including a release that failed after the switch, once a newer one is live.
prune() {
  local current keep dir id
  current="$(current_release)"
  keep="$(tac "$HISTORY" | awk '$2 == "live" && !seen[$3]++ { print $3 }' | head -n "$KEEP")"
  for dir in "$RELEASES"/*/; do
    [ -d "$dir" ] || continue
    id="$(basename "$dir")"
    if [ "$id" = "$current" ] || grep -qxF "$id" <<<"$keep"; then continue; fi
    say "Removing old release $id"
    rm -rf "$dir"
  done
}

# Before 2026-09-18 the app lived directly in $BASE and every deploy overwrote it. The
# first release-based deploy keeps that running copy as legacy-<time>, so there's
# something to roll back to, and removes the old files once the new release is live.
adopt_legacy_layout() {
  [ -L "$BASE/current" ] && return 0
  mkdir -p "$RELEASES" "$SHARED/logs"
  if [ ! -f "$BASE/src/server.js" ]; then return 0; fi
  local id
  id="legacy-$(date -u +%Y%m%d-%H%M%S)"
  say "First release-based deploy: keeping the running app as $id"
  mkdir -p "$RELEASES/$id"
  cp -a "$BASE/src" "$BASE/prisma" "$BASE/package.json" "$BASE/package-lock.json" "$BASE/node_modules" "$RELEASES/$id/"
  if [ -d "$BASE/frontend-ui" ]; then cp -a "$BASE/frontend-ui" "$RELEASES/$id/"; fi
  if [ ! -f "$SHARED/.env" ]; then cp -a "$BASE/.env" "$SHARED/.env"; fi
  ln -sfn "$SHARED/.env" "$RELEASES/$id/.env"
  # Point `current` at the copy without restarting: the same code is what's running.
  ln -sfn "releases/$id" "$BASE/current"
  echo "$(now) live $id" >>"$HISTORY"
}

remove_legacy_files() {
  local stale=()
  for item in src prisma node_modules frontend-ui package.json package-lock.json; do
    [ -e "$BASE/$item" ] && [ ! -L "$BASE/$item" ] && stale+=("$BASE/$item")
  done
  [ ${#stale[@]} -eq 0 ] && return 0
  say "Removing the pre-release copy of the app from $BASE (kept in releases/legacy-*)"
  rm -rf "${stale[@]}"
  if [ -f "$BASE/.env" ] && [ ! -L "$BASE/.env" ]; then ln -sfn "$SHARED/.env" "$BASE/.env.next" && mv -Tf "$BASE/.env.next" "$BASE/.env"; fi
}

# ------------------------------------------------------------------------------ commands

cmd_deploy() {
  local id="$1" tarball="$2" dir previous
  [ -f "$tarball" ] || fail "Missing upload: $tarball"
  adopt_legacy_layout
  mkdir -p "$RELEASES" "$SHARED/logs" "$SHARED/backups"
  [ -f "$SHARED/.env" ] || fail "$SHARED/.env is missing (copy .env.example and fill it in)"
  dir="$RELEASES/$id"
  [ -e "$dir" ] && fail "Release $id already exists"
  previous="$(current_release)"

  echo "📦 Preparing $id"
  mkdir -p "$dir"
  tar -xzf "$tarball" -C "$dir"
  echo "$id" >"$dir/RELEASE"
  ln -sfn "$SHARED/.env" "$dir/.env"
  # Starting from the live release's packages makes an unchanged dependency list quick.
  if [ -n "$previous" ] && [ -d "$RELEASES/$previous/node_modules" ]; then
    cp -a "$RELEASES/$previous/node_modules" "$dir/"
  fi
  say "Installing dependencies"
  (cd "$dir" && npm install --no-audit --no-fund --loglevel=error >/dev/null)
  say "Generating the Prisma client"
  (cd "$dir" && npx prisma generate >/dev/null)

  echo "🔍 Checking it before anyone uses it"
  if [ "${SKIP_PREFLIGHT:-}" = 1 ]; then
    say "Skipped (SKIP_PREFLIGHT=1)"
  elif ! preflight "$dir" "$id"; then
    rm -rf "$dir"
    echo "$(now) failed-preflight $id" >>"$HISTORY"
    fail "$id didn't pass its pre-flight check. Nothing changed: ${previous:-the old release} is still live."
  fi

  echo "🗄  Database"
  migrate "$dir" "$id"

  echo "🔀 Switching to $id"
  activate "$id"
  if check_live "$id"; then
    remove_legacy_files
    prune
    echo "✅ $id is live${previous:+ (roll back with: ./deploy.sh rollback → $previous)}"
    return 0
  fi

  if [ -z "$previous" ]; then fail "$id isn't answering correctly, and there's no earlier release to go back to."; fi
  echo "↩️  $id isn't answering correctly — rolling back to $previous"
  activate "$previous"
  if check_live "$previous"; then
    fail "Rolled back: $previous is live again. $id is kept in releases/ to investigate (pm2 logs $NAME)."
  fi
  fail "Rolled back to $previous, but it isn't answering correctly either — check pm2 logs $NAME now."
}

cmd_rollback() {
  local target="${1:-}" current
  current="$(current_release)"
  [ -n "$current" ] || fail "Nothing has been deployed with releases yet, so there's nothing to roll back to."
  if [ -z "$target" ]; then target="$(previous_release "$current")"; fi
  [ -n "$target" ] || fail "No earlier release to roll back to."
  [ "$target" != "$current" ] || fail "$target is already live."
  echo "↩️  Rolling back from $current to $target"
  say "Code only — the database stays as it is. Backups before each migration: $SHARED/backups"
  activate "$target"
  if check_live "$target"; then
    echo "✅ $target is live (undo with: ./deploy.sh rollback $current)"
    return 0
  fi
  echo "↩️  $target isn't answering correctly — switching back to $current"
  activate "$current"
  check_live "$current" || fail "$current isn't answering correctly either — check pm2 logs $NAME now."
  fail "Rollback to $target failed; $current is live again."
}

cmd_releases() {
  local current
  current="$(current_release)"
  echo "Releases in $RELEASES (newest first):"
  # shellcheck disable=SC2012 # our own release names, no spaces or newlines
  ls -1dt "$RELEASES"/*/ 2>/dev/null | while read -r dir; do
    local id
    id="$(basename "$dir")"
    printf '  %s %s\n' "$([ "$id" = "$current" ] && echo '▶' || echo ' ')" "$id"
  done
  if [ -f "$HISTORY" ]; then
    echo "Recent activity:"
    tail -n 8 "$HISTORY" | sed 's/^/  /'
  fi
}

case "${1:-}" in
  deploy) shift; cmd_deploy "$@" ;;
  rollback) shift; cmd_rollback "$@" ;;
  releases) cmd_releases ;;
  *) fail "Usage: remote-deploy.sh deploy <id> <tarball> | rollback [id] | releases" ;;
esac
