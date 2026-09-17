#!/usr/bin/env bash
# Runs the real deploy.sh, over SSH, against a throwaway "VM" in Docker (sshd, Node 18, PM2)
# and a throwaway MySQL — never the real server. Starts from the layout production had
# before release-based deploys, then checks: adopting it, migrating with a backup, rolling
# back and forward, a release that fails its pre-flight check, a release that breaks after
# the switch (automatic rollback), pruning, and how long requests fail during a switch.
#
#   tests/deploy/test-deploy.sh            (needs Docker; takes a few minutes)
#
# LEGACY_COMMIT is the code the server ran before; the default is what production ran.
set -uo pipefail
cd "$(dirname "$0")/../.."
REPO="$PWD"

LEGACY_COMMIT="${LEGACY_COMMIT:-06c45a5}"
NET=campus-deploy-test
VM=campus-deploy-vm
DB=campus-deploy-mysql
SSH_PORT=2222
WORK="$(mktemp -d)"
PASSED=0
FAILED=()

check() { # check "name" command...
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then PASSED=$((PASSED + 1)); echo "  ✓ $name"; else FAILED+=("$name"); echo "  ✗ $name"; fi
}
heading() { printf '\n%s\n' "$1"; }

cleanup() {
  docker rm -f "$VM" "$DB" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  [ -d "$WORK/broken" ] && git -C "$REPO" worktree remove --force "$WORK/broken" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
# shellcheck disable=SC2086
vm() { ssh -i "$WORK/key" -p "$SSH_PORT" $OPTS azureuser@127.0.0.1 "$@"; }
sql() { docker exec -i "$DB" mysql -uroot -proot -N campus_events 2>/dev/null; }

# A password with every character that needs escaping in a URL or a MySQL option file.
DB_PASSWORD='p@ss:w/rd"x\y'
DB_PASSWORD_URL="$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$DB_PASSWORD")"
DB_URL="mysql://campus:$DB_PASSWORD_URL@$DB:3306/campus_events"

run_deploy() { # run_deploy <dir> <logfile> [args…]; env passes through
  local dir="$1" log="$2"
  shift 2
  (cd "$dir" && VM_HOST=127.0.0.1 SSH_PORT="$SSH_PORT" KEY_PATH="$WORK/key" SSH_OPTS="$OPTS" DATABASE_URL="$DB_URL" ./deploy.sh "$@") >"$log" 2>&1
}
release_of() { grep -o 'Release [^ ]*' "$1" | head -1 | cut -d' ' -f2; }
live_release() { vm 'curl -s http://127.0.0.1:3001/health' | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).release ?? "legacy"' 2>/dev/null; }
pm2_script() { vm 'pm2 jlist' | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).find((p) => p.name === "campus-event-api")?.pm2_env.pm_exec_path'; }
equals() { [ "$1" = "$2" ]; }
contains() { [[ "$1" == *"$2"* ]]; }

# ------------------------------------------------------------------------------ setup
heading "Setting up a fake VM and database"
docker network create "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=campus_events mysql:8 >/dev/null
ssh-keygen -q -t ed25519 -N "" -f "$WORK/key"
mkdir -p "$WORK/image" && cp tests/deploy/fake-vm.Dockerfile "$WORK/image/Dockerfile" && cp "$WORK/key.pub" "$WORK/image/key.pub"
docker build -q -t campus-fake-vm "$WORK/image" >/dev/null || { echo "image build failed"; exit 1; }
docker run -d --name "$VM" --network "$NET" -p "127.0.0.1:$SSH_PORT:22" campus-fake-vm >/dev/null
for _ in $(seq 1 60); do vm true 2>/dev/null && break; sleep 1; done
# Over TCP: the image's first, temporary server doesn't listen on the network.
for _ in $(seq 1 90); do docker exec "$DB" mysql -h127.0.0.1 -uroot -proot -e 'SELECT 1' >/dev/null 2>&1 && break; sleep 2; done
# The image's MYSQL_PASSWORD goes into SQL unescaped, which would eat the backslash — so the
# user is created here, with only the privileges production's app user has.
node -e 'const q = (s) => "\x27" + s.replace(/\\/g, "\\\\").replace(/\x27/g, "\\\x27") + "\x27"; console.log(`CREATE USER \x27campus\x27@\x27%\x27 IDENTIFIED BY ${q(process.argv[1])}; GRANT ALL PRIVILEGES ON campus_events.* TO \x27campus\x27@\x27%\x27;`)' "$DB_PASSWORD" \
  | docker exec -i "$DB" mysql -h127.0.0.1 -uroot -proot 2>/dev/null || { echo "creating the database user failed"; exit 1; }
echo "   fake VM and MySQL are up"

# The server as it was: code at LEGACY_COMMIT, copied straight into ~/campus-event-api and
# started with PM2, like the old deploy.sh did. A laptop has no Key Vault, so .env carries
# the secrets here; on the real VM it doesn't.
heading "Recreating the old layout from $LEGACY_COMMIT"
(cd frontend-ui && npm run build >/dev/null 2>&1) || { echo "frontend build failed"; exit 1; }
mkdir -p "$WORK/legacy/frontend-ui"
git archive "$LEGACY_COMMIT" src prisma package.json package-lock.json | tar -x -C "$WORK/legacy"
cp -R frontend-ui/dist "$WORK/legacy/frontend-ui/dist"
cat >"$WORK/legacy/.env" <<EOF
PORT=3001
TENANT_ID=00000000-0000-0000-0000-000000000000
CLIENT_ID=00000000-0000-0000-0000-000000000000
DATABASE_URL=$DB_URL
GEOAPIFY_API_KEY=not-used
EOF
COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf "$WORK/legacy.tgz" -C "$WORK/legacy" .
docker cp "$WORK/legacy.tgz" "$VM:/tmp/legacy.tgz"
docker exec "$VM" bash -c 'mkdir -p /home/azureuser/campus-event-api && tar -xzf /tmp/legacy.tgz -C /home/azureuser/campus-event-api && chown -R azureuser:azureuser /home/azureuser/campus-event-api'
vm "cd ~/campus-event-api && npm install --no-audit --no-fund --loglevel=error >/dev/null && npx prisma generate >/dev/null \
  && DATABASE_URL='$DB_URL' npx prisma migrate deploy >/dev/null && pm2 start src/server.js --name campus-event-api >/dev/null && pm2 save >/dev/null" \
  || { echo "legacy setup failed"; exit 1; }
for _ in $(seq 1 30); do vm 'curl -fs http://127.0.0.1:3001/health' >/dev/null 2>&1 && break; sleep 1; done
check "the old app is running from ~/campus-event-api/src" contains "$(pm2_script)" "campus-event-api/src/server.js"

# ------------------------------------------------------------------------------ first deploy
heading "First release-based deploy (adopts the old layout, runs a migration)"
# Count failed requests while the switch happens.
vm 'nohup bash -c "while true; do curl -s -o /dev/null -w \"%{http_code}\n\" --max-time 1 http://127.0.0.1:3001/events/api/me; sleep 0.1; done" >/tmp/probe.log 2>&1 </dev/null & echo $! >/tmp/probe.pid'
run_deploy "$REPO" "$WORK/deploy1.log"
status=$?
vm 'kill $(cat /tmp/probe.pid)'
FIRST="$(release_of "$WORK/deploy1.log")"
check "deploy succeeds" equals "$status" 0
check "the new release answers /health" equals "$(live_release)" "$FIRST"
check "current → releases/$FIRST" equals "$(vm 'readlink ~/campus-event-api/current')" "releases/$FIRST"
check "PM2 runs the release directory, not a symlink" equals "$(pm2_script)" "/home/azureuser/campus-event-api/releases/$FIRST/src/server.js"
check "the old copy was kept as a legacy-* release" vm 'ls -d ~/campus-event-api/releases/legacy-*'
check "…and the old top-level files are gone" vm '! test -e ~/campus-event-api/src && ! test -e ~/campus-event-api/node_modules'
check "the pending migration ran" contains "$(echo 'SHOW TABLES' | sql)" "outbox_jobs"
BACKUP="$(vm 'ls ~/campus-event-api/shared/backups/')"
check "a backup was taken first" contains "$BACKUP" "$FIRST-before-migrate.sql.gz"
check "…it's a real dump of the old schema, without outbox_jobs" vm "gunzip -c ~/campus-event-api/shared/backups/$FIRST-before-migrate.sql.gz | grep -q 'CREATE TABLE \`event_images\`' && ! gunzip -c ~/campus-event-api/shared/backups/$FIRST-before-migrate.sql.gz | grep -q outbox_jobs"
check "…readable only by its owner" equals "$(vm "stat -c %a ~/campus-event-api/shared/backups/$FIRST-before-migrate.sql.gz")" 600
check "the database URL isn't in PM2's saved state" vm '! grep -q DATABASE_URL ~/.pm2/dump.pm2'
check "…nor left in any file under /tmp" vm "! grep -rqs 'campus:' /tmp"
FAILS="$(vm "grep -vc '^401$' /tmp/probe.log" || true)"
TOTAL="$(vm 'wc -l </tmp/probe.log')"
echo "   (during the deploy, $FAILS of $TOTAL probe requests failed — about $(( FAILS / 10 ))s without the app)"
check "requests failed for under 10 seconds" test "${FAILS:-999}" -lt 100

# ------------------------------------------------------------------------------ rollback
heading "Rolling back and forward"
run_deploy "$REPO" "$WORK/rollback1.log" rollback
check "rollback succeeds" equals "$?" 0
check "the legacy release is live again" equals "$(live_release)" legacy
check "PM2 runs the legacy directory" contains "$(pm2_script)" "/releases/legacy-"
run_deploy "$REPO" "$WORK/rollback2.log" rollback
check "rolling back again returns to the newer release" equals "$(live_release)" "$FIRST"
run_deploy "$REPO" "$WORK/rollback3.log" rollback no-such-release
check "rolling back to a release that doesn't exist fails" test "$?" -ne 0
check "…and changes nothing" equals "$(live_release)" "$FIRST"

# ------------------------------------------------------------------------------ second deploy
heading "A deploy with nothing to migrate"
sleep 1 # release ids have one-second resolution
run_deploy "$REPO" "$WORK/deploy2.log"
check "deploy succeeds" equals "$?" 0
SECOND="$(release_of "$WORK/deploy2.log")"
check "the second release is live" equals "$(live_release)" "$SECOND"
check "no migrations, so no new backup" equals "$(vm 'ls ~/campus-event-api/shared/backups/ | wc -l' | tr -d ' ')" 1
check "it says so" grep -q "No pending migrations" "$WORK/deploy2.log"

# ------------------------------------------------------------------------------ broken releases
# A commit whose server crashes on start, in a separate worktree so the real checkout is untouched.
git worktree add --detach "$WORK/broken" HEAD >/dev/null 2>&1
ln -s "$REPO/frontend-ui/node_modules" "$WORK/broken/frontend-ui/node_modules"
printf 'throw new Error("deliberately broken release");\n' | cat - "$WORK/broken/src/server.js" >"$WORK/server.js" && mv "$WORK/server.js" "$WORK/broken/src/server.js"

heading "A release that can't start is stopped by the pre-flight check"
sleep 1
ALLOW_DIRTY=1 run_deploy "$WORK/broken" "$WORK/deploy-broken.log"
check "deploy fails" test "$?" -ne 0
BROKEN="$(release_of "$WORK/deploy-broken.log")"
check "it names the pre-flight check" grep -q "didn't pass its pre-flight check" "$WORK/deploy-broken.log"
check "…and shows the crash" grep -q "deliberately broken release" "$WORK/deploy-broken.log"
check "the good release never stopped serving" equals "$(live_release)" "$SECOND"
check "the broken release directory was removed" vm "! test -e ~/campus-event-api/releases/$BROKEN"

heading "A release that breaks after the switch is rolled back automatically"
sleep 1
ALLOW_DIRTY=1 SKIP_PREFLIGHT=1 run_deploy "$WORK/broken" "$WORK/deploy-broken-live.log"
check "deploy fails" test "$?" -ne 0
check "it rolled back on its own" grep -q "rolling back to $SECOND" "$WORK/deploy-broken-live.log"
check "the previous release is live again" equals "$(live_release)" "$SECOND"
check "PM2 runs the previous release" equals "$(pm2_script)" "/home/azureuser/campus-event-api/releases/$SECOND/src/server.js"
check "the failure is in the history" vm 'grep -q failed-live ~/campus-event-api/releases.log'

# ------------------------------------------------------------------------------ pruning
heading "Old releases are pruned"
sleep 1
KEEP_RELEASES=2 run_deploy "$REPO" "$WORK/deploy3.log"
check "deploy succeeds" equals "$?" 0
THIRD="$(release_of "$WORK/deploy3.log")"
KEPT="$(vm 'ls ~/campus-event-api/releases')"
check "only 2 releases are kept" equals "$(echo "$KEPT" | wc -l | tr -d ' ')" 2
check "…the live one" contains "$KEPT" "$THIRD"
check "…and the one to roll back to" contains "$KEPT" "$SECOND"
run_deploy "$REPO" "$WORK/releases.log" releases
check "./deploy.sh releases marks the live one" grep -q "▶ $THIRD" "$WORK/releases.log"

heading "Uncommitted changes"
if [ -z "$(git status --porcelain)" ]; then
  touch "$REPO/.deploy-test-untracked"
  run_deploy "$REPO" "$WORK/dirty.log"
  check "a deploy with uncommitted changes is refused" test "$?" -ne 0
  rm -f "$REPO/.deploy-test-untracked"
  check "…before anything is uploaded" equals "$(live_release)" "$THIRD"
else
  echo "   (skipped: this checkout already has uncommitted changes)"
fi

echo
echo "$PASSED passed, ${#FAILED[@]} failed"
[ ${#FAILED[@]} -gt 0 ] && printf '  ✗ %s\n' "${FAILED[@]}"
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "Logs: keep them by re-running with the trap removed; last deploy output:"
  tail -n 30 "$WORK"/deploy*.log
fi
[ ${#FAILED[@]} -eq 0 ]
