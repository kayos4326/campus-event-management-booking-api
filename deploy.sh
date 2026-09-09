#!/bin/bash
set -e

# --- Configuration ---
VM_USER="azureuser"
VM_HOST="chaotic-hell.eastasia.cloudapp.azure.com"
KEY_PATH="$HOME/.ssh/bad-vps-01_key.pem"
TARGET_DIR="~/campus-event-api"

echo "🚀 Step 1: Transferring backend files to Azure VM..."
ssh -i "$KEY_PATH" "$VM_USER@$VM_HOST" "mkdir -p $TARGET_DIR"
scp -r -i "$KEY_PATH" package.json package-lock.json src prisma "$VM_USER@$VM_HOST:$TARGET_DIR/"

echo "🔑 Step 2: Fetching DATABASE_URL from Key Vault for the migration step..."
# `prisma migrate deploy` is a standalone CLI command, not routed through the app's own
# Key Vault bootstrap — it needs DATABASE_URL directly. Fetched here and passed only to
# this one remote command; never written to .env or disk on the VM.
DB_URL=$(az keyvault secret show --vault-name campus-event-api-kv --name database-url --query value -o tsv)

echo "🔄 Step 3: Installing deps, generating Prisma client, applying migrations, restarting..."
ssh -i "$KEY_PATH" "$VM_USER@$VM_HOST" "DATABASE_URL='$DB_URL' bash -s" <<'REMOTE'
  set -e
  cd ~/campus-event-api
  npm install
  npx prisma generate
  npx prisma migrate deploy
  pm2 restart campus-event-api || pm2 start src/server.js --name campus-event-api
  pm2 save
REMOTE

echo "✅ Deployment complete!"
