#!/usr/bin/env bash
# Deploys to the VM as a new release, with a check before it goes live and a way back.
#
#   ./deploy.sh                  build, upload, check, migrate and switch to a new release
#   ./deploy.sh rollback         go back to the release that was live before this one
#   ./deploy.sh rollback <id>    go to a specific release (see: ./deploy.sh releases)
#   ./deploy.sh releases         list releases on the server
#
# What a deploy does (the server side is scripts/remote-deploy.sh):
#   1. Builds the frontend here and packs the committed code with it.
#   2. Unpacks it on the VM as releases/<time>-<commit>, installs packages, generates Prisma.
#   3. Pre-flight: starts that release on a spare port and checks it answers — while users
#      stay on the current release. A release that won't start never goes live.
#   4. Backs up the database if there are migrations to run, then runs them.
#   5. Switches PM2 to the new release and checks it again; if it isn't healthy, switches
#      straight back to the previous one.
#
# Rollback switches code only; the database isn't touched. So a migration must keep working
# with the release before it (add columns and tables; don't rename or drop in the same
# deploy). Each migration run leaves a backup in shared/backups on the VM.
#
# Settings (environment): VM_USER, VM_HOST, KEY_PATH, SSH_PORT, SSH_OPTS; DATABASE_URL (else
# read from Key Vault); SKIP_PREFLIGHT=1; KEEP_RELEASES (default 5); ALLOW_DIRTY=1 to deploy
# uncommitted changes.
set -euo pipefail
cd "$(dirname "$0")"

VM_USER="${VM_USER:-azureuser}"
VM_HOST="${VM_HOST:-chaotic-hell.eastasia.cloudapp.azure.com}"
KEY_PATH="${KEY_PATH:-$HOME/.ssh/bad-vps-01_key.pem}"
SSH_PORT="${SSH_PORT:-22}"
# shellcheck disable=SC2206
EXTRA_OPTS=(${SSH_OPTS:-})
# ${arr[@]+…}: macOS ships bash 3.2, where an empty array is "unbound" under set -u.
SSH=(ssh -i "$KEY_PATH" -p "$SSH_PORT" -o BatchMode=yes ${EXTRA_OPTS[@]+"${EXTRA_OPTS[@]}"} "$VM_USER@$VM_HOST")
SCP=(scp -q -i "$KEY_PATH" -P "$SSH_PORT" -o BatchMode=yes ${EXTRA_OPTS[@]+"${EXTRA_OPTS[@]}"})

WORK="$(mktemp -d)"
REMOTE_DIR=""
cleanup() {
  rm -rf "$WORK"
  if [ -n "$REMOTE_DIR" ]; then "${SSH[@]}" "rm -rf '$REMOTE_DIR'" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

# Uploads the server-side script and runs it. Settings go over stdin, never on a command line.
run_remote() {
  local settings="$1"
  shift
  local args="$*"
  REMOTE_DIR="$("${SSH[@]}" 'mktemp -d /tmp/campus-deploy.XXXXXX')"
  "${SCP[@]}" scripts/remote-deploy.sh "$VM_USER@$VM_HOST:$REMOTE_DIR/"
  if [ -n "${UPLOAD:-}" ]; then
    "${SCP[@]}" "$UPLOAD" "$VM_USER@$VM_HOST:$REMOTE_DIR/release.tgz"
    args="$args $REMOTE_DIR/release.tgz"
  fi
  printf '%s\n\n' "$settings" | "${SSH[@]}" "bash '$REMOTE_DIR/remote-deploy.sh' $args"
}

case "${1:-deploy}" in
  rollback)
    run_remote "" rollback "${2:-}"
    exit
    ;;
  releases)
    run_remote "" releases
    exit
    ;;
  deploy) ;;
  *)
    sed -n '2,7p' "$0"
    exit 2
    ;;
esac

# ------------------------------------------------------------------------------ deploy

if [ -n "$(git status --porcelain)" ] && [ "${ALLOW_DIRTY:-}" != 1 ]; then
  echo "❌ You have uncommitted changes. Commit them first, so the release id names exactly what's deployed"
  echo "   (or run with ALLOW_DIRTY=1)."
  git status --short
  exit 1
fi

COMMIT="$(git rev-parse --short HEAD)"
[ -n "$(git status --porcelain)" ] && COMMIT="$COMMIT-dirty"
RELEASE="$(date -u +%Y%m%d-%H%M%S)-$COMMIT"
echo "🚀 Release $RELEASE → $VM_HOST"

echo "🖼  Building the frontend"
(cd frontend-ui && npm run build >"$WORK/frontend-build.log" 2>&1) || { tail -n 30 "$WORK/frontend-build.log"; exit 1; }

echo "📦 Packing"
mkdir -p "$WORK/release/frontend-ui"
if [ "${COMMIT%-dirty}" = "$COMMIT" ]; then
  git archive HEAD src prisma package.json package-lock.json | tar -x -C "$WORK/release"
else
  cp -R src prisma package.json package-lock.json "$WORK/release/"
fi
cp -R frontend-ui/dist "$WORK/release/frontend-ui/dist"
# macOS tar would otherwise pack Apple metadata (._* files, xattr headers) that Linux tar
# warns about; those flags only exist in bsdtar, so a Linux machine packs without them.
TAR_FLAGS=()
if tar --version 2>/dev/null | grep -q bsdtar; then TAR_FLAGS=(--no-mac-metadata --no-xattrs); fi
COPYFILE_DISABLE=1 tar ${TAR_FLAGS[@]+"${TAR_FLAGS[@]}"} -czf "$WORK/release.tgz" -C "$WORK/release" .

# `prisma migrate deploy` runs outside the app's own Key Vault bootstrap, so it needs the
# connection string passed in. It goes to the server over stdin and is never written there.
if [ -z "${DATABASE_URL:-}" ]; then
  echo "🔑 Reading DATABASE_URL from Key Vault for the migration step"
  DATABASE_URL="$(az keyvault secret show --vault-name campus-event-api-kv --name database-url --query value -o tsv)"
fi

SETTINGS="DATABASE_URL=$DATABASE_URL"
[ -n "${SKIP_PREFLIGHT:-}" ] && SETTINGS+=$'\n'"SKIP_PREFLIGHT=$SKIP_PREFLIGHT"
[ -n "${KEEP_RELEASES:-}" ] && SETTINGS+=$'\n'"KEEP_RELEASES=$KEEP_RELEASES"

UPLOAD="$WORK/release.tgz"
run_remote "$SETTINGS" deploy "$RELEASE"
