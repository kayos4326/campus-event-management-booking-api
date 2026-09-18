# Campus Events

Book seats at university events. Organizers publish events, students reserve a seat (or join
the waitlist when it's full), and admins look after people and access.

**Live:** https://chaotic-hell.eastasia.cloudapp.azure.com/events/ — sign in with your AU
Microsoft account.

CSX4110 Backend Application Development, semester 1/2026 — Thar Lin Htet (6642062),
Honey Linn (6726113), Mi Hsu Myat Win Wyint (6726115).

## What it does

- **Students** browse published events, book or join the waitlist, and cancel. When someone
  cancels, the next person on the waitlist gets the seat automatically.
- **Organizers** create events with a venue (dropped as a pin on a map), a capacity, a cover
  image and an optional supply order ("200 × lanyards") that's posted to the team's Discord.
- **Admins** manage roles, see all events and bookings, read the activity log, and issue API
  keys for the public room-status endpoint.

## How it's built

Node.js + Express, MySQL through Prisma, and a React (Vite) frontend served by the same app.
Sign-in is Microsoft Entra ID: the API verifies Microsoft's tokens and checks roles on every
request. Secrets live in Azure Key Vault. It runs on an Azure VM behind Nginx under PM2.

Things worth knowing before you change something:

- Booking runs inside a transaction that locks the event row, so two people can't take the
  last seat at the same time.
- Every request body is checked against a schema in `src/validation/schemas.js`.
- Work that has to happen after a change, like posting a supply order to Discord, goes
  through an outbox (`src/services/outbox.js`): it's saved with the change and retried until
  it goes through.

## Running it

**Tests** — no database, Microsoft account or internet needed:

```bash
npm install
npm test
```

**The whole stack in Docker** (app + MySQL):

```bash
docker compose up --build
```

Then open http://localhost:3001/events/. The page and API run, but you can't sign in there:
Microsoft only sends people back to addresses registered on the Entra app.

**Working on the frontend:**

```bash
cd frontend-ui
npm install
npm run dev
```

This talks to the live API, so you see real data — but you can't sign in from `localhost`:
that address isn't registered with Microsoft (see below). Thar can add it to the Entra app
registration if local sign-in is needed.

End-to-end tests (real MySQL, real Chrome, a fake Discord) are described in
[tests/e2e/README.md](tests/e2e/README.md).

## Running it from a zip (marking, or a teammate with no access)

Everything needed is in the repository — no secrets, no Azure access:

```bash
npm install && npm test          # 204 tests, no database or network needed
docker compose up --build        # the whole stack, then http://localhost:3001/events/
```

Both were checked from a fresh unpacked zip: the tests pass, and Docker creates the database,
applies all seven migrations and serves the app.

**Signing in only works on the live site.** Microsoft only returns people to web addresses
registered on our Entra app, and only `https://chaotic-hell.eastasia.cloudapp.azure.com/events/`
is registered — `localhost` is not (verified against Microsoft's sign-in service). So a local
copy shows the sign-in page and the API correctly answers 401, but you can't sign in to it. To
see the app in use, use the live site. A first-time visitor signs in as a Student; an admin can
change that from the Admin tab.

To make a zip without the installed packages:

```bash
git archive --format=zip HEAD -o campus-events.zip
```

## Deploying

Needs the VM's SSH key and Azure CLI access to the Key Vault.

```bash
./deploy.sh                # build, check, back up + migrate, switch to a new release
./deploy.sh rollback       # back to the release that was live before
./deploy.sh releases       # what's on the server
```

A new release is started on a spare port and checked before any user reaches it; if it's
unhealthy after the switch, the previous release comes back on its own. Rollback changes code
only, so migrations must keep working with the release before them (add, don't rename or
drop). Commit before deploying — the release is named after the commit.

CI (GitHub Actions) runs the tests, applies every migration to an empty MySQL, checks the
migrations match the schema, lints and builds the frontend, and builds the Docker image.

## Where things are

```
src/            API: routes/, services/ (bookings, outbox, Discord, images), validation/
prisma/         schema and migrations
frontend-ui/    React app
tests/          unit/ and integration/ (npm test), e2e/, deploy/
scripts/        the part of the deploy that runs on the VM
docs/           the submitted proposal
```

`CLAUDE.md` holds the detailed project notes: why things are the way they are, what was
tested and what went wrong along the way.
