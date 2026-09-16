# Multi-stage so the runtime image carries no build tooling and no dev dependencies.
# Layers are ordered cheapest-to-change-last: lockfiles before source, so a code edit
# doesn't reinstall node_modules.

# 1) Build the React frontend (Express serves it from frontend-ui/dist — see src/app.js)
FROM node:20-alpine AS frontend
WORKDIR /frontend
COPY frontend-ui/package.json frontend-ui/package-lock.json ./
# `npm install`, not `npm ci`: the lockfiles are generated on macOS and don't carry the
# Linux-only optional binaries these toolchains need. Same command deploy.sh runs on the VM.
RUN npm install
COPY frontend-ui/ ./
RUN npm run build

# 2) Production dependencies + the Prisma client for this schema
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
# Dev deps are needed to run `prisma generate`, then pruned so they don't ship.
RUN npm install && npx prisma generate && npm prune --omit=dev

# 3) Runtime
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3001
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY src ./src
COPY --from=frontend /frontend/dist ./frontend-ui/dist
USER node
EXPOSE 3001
# Apply any pending migrations, then start. Secrets come from Key Vault in production, or
# straight from the environment when there's no managed identity (see config/keyvault.js).
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
