# CLAUDE.md — Campus Event Management & Booking API

Context file for AI assistants (Claude Code, etc.) working on this repo.
Course: **CSX4110 Backend Application Development**, Semester 1/2026.
This is "Option 3" of four class project options, in a mandatory peer-API ring
with three other student teams.

---

## 1. Project Concept

A platform where university organizations create events and students book seats.

- **Organizer flow**: logs in via university AD → creates an event (venue, time, capacity)
- **Student flow**: logs in via university AD → RSVPs / books a seat
- Venue address is validated and a static map is generated via an external mapping API
- If an organizer creates a **large tech conference** event, the backend automatically
  calls a partner team's Merchandise API to pre-order 50 blank university lanyards

---

## 2. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Backend | Node.js + Express | Reusing the proven pattern from the weekly lab series (`backend-crud-api`) rather than the Go alternative |
| Database | Relational (MySQL/PostgreSQL) via **Prisma ORM** | Migrations required. **Pin `prisma@6` + `@prisma/client@6` explicitly** — v7 breaks the `new PrismaClient()` instantiation pattern used throughout the lab series |
| Auth | JWT + RBAC, backed by **Microsoft Entra ID (AD)** via MSAL / OAuth2 / OIDC | Self-provisioned tenant (see §4) |
| Secrets | **Azure Key Vault**, fetched at runtime | No `.env` secrets in production — `.env` only holds non-secret bootstrap config (tenant ID, client ID, vault URL) |
| External API | **Geoapify** (venue address validation + static map links) | Switched from Mapbox → Geoapify for a zero-cost, no-card-required free tier |
| Peer integration | REST, `x-api-key` header auth | See §5 |
| Hosting | Same VPS as the existing lab/WordPress stack | New URL path, must not break existing routes (see §3) |
| Source control | GitHub | Automated deploy via script or Docker Compose |

---

## 3. Deployment Target (shared VPS)

This app deploys **alongside existing infrastructure on the same VPS** — it does not get its own box.

- VM: `bad-vps-01` @ `chaotic-hell.eastasia.cloudapp.azure.com`
- SSH: `ssh -i ~/.ssh/bad-vps-01_key.pem azureuser@chaotic-hell.eastasia.cloudapp.azure.com` (confirmed working)
- System Node on the VM is **v18.19.1** (not v20) — this app's `package.json` targets `>=18.18.0` to match, rather than requiring an nvm install alongside the system Node used by `crud-api`
- Existing routes that **must not break**:
  - `/content` → WordPress (proxied to `127.0.0.1:8080`)
  - `/api` → existing lab CRUD API (`backend-crud-api`, run under PM2 as `crud-api`, on `127.0.0.1:3000`)
- **This app's path: `/events`**, proxied to `127.0.0.1:3001` (matches the scaffold's default `PORT`) — single Nginx site `azure-proxy` at `/etc/nginx/sites-available/azure-proxy`, single Certbot cert covering the whole domain (expires 2026-09-22, auto-renewed)
- ⚠️ Nginx config for the `/events` block itself is not yet written/deployed — only decided

---

## 4. Auth & Secrets — Rationale

The school does **not** issue AD or Key Vault credentials for the capstone project itself. Plan:

- Self-provision a separate **Entra tenant** for this app
- Self-provision a separate **Azure Key Vault**, accessed via **VM managed identity**
- Reuse the *pattern* already proven working in the lab series' Key Vault week:
  ```
  bootstrapServer() {
    // DefaultAzureCredential + SecretClient
    // fetch secrets BEFORE app.listen()
  }
  ```
- Lab reference values (same pattern, **different resource** — do not assume these are reused for the capstone):
  - Vault: `thar-csx4110-kv`, resource group `BAD-2026-RG`
  - App registration: `backend-api-identity`
  - Tenant ID: `6f4432dc-20d2-441d-b1db-ac3380ba633d`
  - Client ID: `0840d62b-b6f2-43f1-99e3-8def7cc3455b`
  - RBAC split: self = *Key Vault Secrets Officer* (write), app identity = *Key Vault Secrets User* (read)
  - Note: East US region was blocked on the student subscription — needed a different region
- ⚠️ **Not yet confirmed**: whether the capstone's *own* Entra tenant + Key Vault instance have actually been created, or this is still just the plan

---

## 5. Peer API Ring

Class-wide structure: **Ticketing → Events (this project) → Merch → EduCore → Ticketing**
Every team must both expose an endpoint and consume a partner's endpoint, all secured with a static `x-api-key`.

### Consume (this app → Merch team, Option 1)
- Purpose: auto pre-order 50 blank university lanyards when a large tech conference event is created
- Auth: static `x-api-key` issued **by** the Merch team
- Status: Merch team originally only exposed `GET /api/products/available` (read-only, no ordering). They've **agreed to add a peer order-creation endpoint** to close this gap — exact contract not yet finalized on their side.

### Expose (Ticketing team, Option 2 → this app)
- Endpoint: `GET /api/peer/events/active?room=<number>`
- Auth: static `x-api-key` issued **by this app** to the Ticketing team
- Consequence: `Venue` model needs a `room_number` column to support this query param
- Note: Ticketing's proposal also documents a ticket-creation endpoint intended for this Events system — **not needed**, since Merch is the consume partner, not Ticketing

---

## 6. Design Doc / Submission Conventions

- Format matches the fuller class-proposal template: problem statement, objectives, scope, functional/non-functional requirements, deployment diagram
- Title page: AU-crest style, student voice, matched to the Ticketing team's format
- Instructor: Arjan Dr. Chayapol Moemeng

---

## 7. Reusable Patterns from the Lab Series (same student, different project — `backend-crud-api`)

These aren't part of this repo, but are proven approaches worth mirroring:

- Prisma migrations workflow: introspect + baseline existing DB, then `prisma generate` + `migrate deploy` folded into `deploy.sh`
- JWT-protected CRUD pattern already built and deployed against a live Azure MySQL DB
- Redis cache-aside pattern (`ioredis`): check cache → fall back to Prisma/MySQL → write-through with TTL, invalidate on POST/PUT/DELETE
- Docker: multi-stage-friendly `Dockerfile` (`node:20-alpine`, `.dockerignore` excludes `.env`, `COPY package*.json` before `COPY .` for layer caching)
- Docker Hub account for image publishing: `kayostt`

---

## 8. Open Items (genuinely undecided — don't assume answers)

- [ ] DB schema for events/venues/bookings beyond `Venue.room_number` (starter schema now in `prisma/schema.prisma`, not final)
- [x] URL path for this app on `bad-vps-01` → `/events` (see §3) — Nginx block not yet deployed
- [ ] Whether the capstone-specific Entra tenant + Key Vault have been provisioned yet
- [ ] Geoapify API key — obtained or not
- [ ] Merch team's peer order-creation endpoint — final request/response shape
- [x] Repo scaffold — done, see `src/`, `prisma/schema.prisma`, `Dockerfile`
