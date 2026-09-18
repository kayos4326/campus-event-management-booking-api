# Video presentation — running order (10 minutes, three people)

Assignment: record a maximum 10-minute video of the **live, deployed** project, walk through the
codebase (**Azure Key Vault** and the **Prisma schema** specifically), and show the core features
working. Submit in the MS Teams assignment channel.

Target length **9:30**, so a slow page load doesn't push you over 10:00.

## Who does what

The three accounts already have the three different roles, so nobody has to pretend:

| Person | Account | Role in the app | Part of the video |
|---|---|---|---|
| **Thar** | u6642062@au.edu | Admin | Intro, code walkthrough, admin + infrastructure, closing |
| **Mi Hsu** | u6726115@au.edu | Organizer | Creating a venue and an event, Discord supply order |
| **Honey** | u6726113@au.edu | Student | Booking, the ticket, cancelling, the waitlist |

## How to record

One Microsoft Teams meeting with the three of you. Start the recording, then take turns sharing
your screen. Teams saves it and you submit the link in the assignment channel.

- Share **one browser window**, not the whole desktop, so nothing private appears.
- Everyone not speaking: microphone and camera off.
- Ask the speaker to say the next person's name ("over to Mi Hsu") so screen sharing is clean.
- Do a 60-second test recording first and check the screen text is readable.
- If a live step fails, say what should have happened and move on — do not restart the recording.
  You can re-record one person's part and stitch, but a calm recovery looks better than a retake.

---

## Before you press record (30 minutes)

1. **Everyone signs in once** at https://chaotic-hell.eastasia.cloudapp.azure.com/events/ and
   confirms their role shows in the top-right corner (Admin / Organizer / Student). Sign in again
   right before recording — the app signs you out after 15 minutes of inactivity.
2. **Tidy the live data (Thar).** Discover currently shows test events called `sdd`, `niioio` and
   `qqqq`, and there's a junk venue called `vmes`. Cancel those events (My events → Cancel) and
   remove the venue (Venues → Remove). Cancelled events disappear from the student's Discover
   page. Keep "CSX4110 Capstone Demo Day".
3. **Discord (Thar).** Open the CSX4110 project channel in a tab and delete the two old `[E2E]`
   test messages, so the supply order that arrives on camera is obviously new.
4. **Cover image (Mi Hsu).** Put a wide photo (roughly 1200×675) on your desktop, named something
   sensible like `career-fair.jpg`.
5. **Commands (Thar).** Open `docs/demo-commands.txt` (next to this file) in a text editor and
   copy-paste from it — never type commands live.
6. **Start the VM early.** If it has been shut down, start it and wait two minutes — Nginx,
   MySQL, both apps and fail2ban come back automatically, but not instantly. Check
   https://chaotic-hell.eastasia.cloudapp.azure.com/events/ loads before you record.
7. **Windows to have open before recording:** editor with the project, terminal already connected
   to the VM, the live site, the Azure portal or terminal for Key Vault, Discord.

---

## The running order

### 1. Thar — opening (0:00–0:40)

Screen: the live site's sign-in page.

> "This is Campus Events, our CSX4110 project — Thar, Honey and Mi Hsu. It's live at
> chaotic-hell.eastasia.cloudapp.azure.com/events, running on our hardened Azure VM behind Nginx
> with Let's Encrypt. Students book seats at university events, organizers publish them, and
> everyone signs in with their real AU Microsoft account. I'll show the code first, then Mi Hsu
> and Honey will use the live site."

### 2. Thar — Azure Key Vault (0:40–2:00)

The assignment names this explicitly, so be slow and clear here.

1. Terminal, on the VM: `cat ~/campus-event-api/shared/.env`
   > "This is the only config file on the server. Port, tenant ID, client ID, vault URL — **no
   > secrets at all**."
2. `az keyvault secret list --vault-name campus-event-api-kv -o table`
   > "The three real secrets live in Azure Key Vault: the database connection string, the Geoapify
   > key and the Discord webhook."
3. Editor: `src/config/keyvault.js`, then `src/server.js`.
   > "At startup the app authenticates to the vault with the VM's managed identity — no password
   > anywhere — fetches the secrets, and only then starts the server. That order matters: Prisma
   > reads the connection string when it's created, so if we started the server first, every
   > database query would fail."

### 3. Thar — Prisma schema and migrations (2:00–3:00)

1. Editor: `prisma/schema.prisma`. Scroll slowly through `User`, `Venue`, `Event`, `Booking`.
   > "Eight models. An event belongs to an organizer and a venue; a booking joins a student to an
   > event and is Confirmed, Waitlisted or Cancelled. This unique constraint is what stops the
   > same student booking twice."
2. `ls prisma/migrations` — then on the VM:
   `sudo mysql -e "SELECT migration_name, finished_at FROM _prisma_migrations" campus_events`
   > "Seven migrations, all applied to the live MySQL database. Every deploy runs
   > `prisma migrate deploy`, so the schema and the code move together."
3. One sentence on the seat race, with `src/services/bookings.js` on screen:
   > "Booking runs in a transaction that locks the event row, so two students can't take the last
   > seat at the same moment. We proved that against the live database: the old code gave 12
   > people the same single seat; this code never does."

> "Over to Mi Hsu, who'll create a real event."

### 4. Mi Hsu — organizer (3:00–5:20)

Screen: the live site, signed out.

1. **Sign in** → "Sign in with Microsoft" → pick your AU account.
   > "This is the university's real Microsoft sign-in — our app never sees a password. It gets a
   > token, checks it against Microsoft's keys, and reads my role: Organizer."
2. **My events → Add venue.** Type "Assumption University" in the search, click the campus on the
   map to drop the pin, room number `301`, save.
   > "The address comes from the pin through the Geoapify API — that's our external API — so a
   > venue can't end up in the wrong country."
3. **New event.** Fill in:
   - Title: `Career Fair 2026`
   - Cover image: drag in your photo (say: "the browser resizes it before uploading")
   - Starts: **today, an hour ago**; Ends: **today, in two hours** (needed for the room-status API later)
   - Venue: AU Grand Hall (room 301) · Capacity: **1** (say: "one seat, so we can show the waitlist")
   - Order supplies: `Lanyards`, quantity `50`
   - Publish now → **Publish event**
4. Switch to the **Discord tab**: the supply order message is there.
   > "Publishing writes the order and a delivery job in the same database transaction, and a worker
   > sends it to Discord and retries if Discord is down — it can't be lost."
5. Back to **Discover**: the event is there with its photo.

> "Honey, it's yours."

### 5. Honey — student (5:20–6:40)

Screen: the live site, signed in as you.

1. Point out the top right: **Student**.
   > "Same sign-in, but the app gives me the student view — I don't get the organizer or admin tabs
   > at all, and the API refuses those actions even if you call it directly."
2. **Discover** → Mi Hsu's event → **Reserve a seat** → the toast confirms.
3. **My bookings** → show the ticket, the date, "Directions".
4. Say (don't do it yet):
   > "That was the only seat. Watch what happens when someone else tries."

### 6. Thar — admin, roles and the waitlist (6:40–8:00)

Screen: the live site as Admin.

1. **Admin → People.** 
   > "As an admin I manage roles. Mi Hsu is an Organizer — I'll make her a Student for a moment so
   > we can show the waitlist."
   Change Mi Hsu to Student.
2. **Mi Hsu** refreshes, opens Discover, clicks **Join waitlist** → "You're on the waitlist".
3. **Honey** opens My bookings → **Cancel booking** → confirm.
4. **Mi Hsu** refreshes My bookings: she is now **Confirmed**.
   > "The seat moved to the next person automatically, in the same transaction as the cancellation."
5. **Admin → Activity.**
   > "Every organizer and admin action is recorded — who did what, and when."

### 7. Thar — the API we expose, and the infrastructure (8:00–9:10)

1. **Admin → API keys → Issue key** (label: `Room display`). Copy it.
2. Terminal, paste the prepared curl (it's in `docs/demo-commands.txt`):
   > "This is the endpoint we expose for another system to consume, protected by an API key we
   > issue and store hashed. It says whether a room is in use right now."
   The answer shows `"active": true` with Mi Hsu's event, because it's running now.
   Then run the same call with a wrong key → `401`.
3. Infrastructure, quickly:
   - `sudo ufw status`, then the two `grep` commands in the command sheet
     > "Key-only SSH, firewall on, automatic updates, and fail2ban. This isn't theoretical: the
     > logs show 9,588 login attempts from 310 different addresses, and fail2ban has banned them
     > 46 times."
     (The live counters in `fail2ban-client status` reset when the VM restarts, so read the logs
     instead — those numbers are real and they survive a reboot.)
   - `./deploy.sh releases`
     > "Every deploy is its own release. A new release is health-checked on a spare port before any
     > user reaches it, the database is backed up before migrations, and `./deploy.sh rollback`
     > puts the previous one back. We tested that by deliberately deploying a broken build."

### 8. Thar — closing (9:10–9:30)

> "So: hardened VPS, Nginx with SSL under our own path, Express and MySQL with Prisma migrations,
> Microsoft sign-in with role-based access, secrets from Azure Key Vault, Geoapify and Discord,
> an API-key endpoint for other systems, and an automated deploy with rollback. Beyond the brief we
> added 204 automated tests, plus end-to-end tests that drive a real browser. Thank you."

---

## What the teacher asked for, and where it appears

| Requirement | Where in the video |
|---|---|
| 1. Hardened VPS | 7 (ufw, fail2ban, key-only SSH) |
| 2. Nginx + SSL, own path, other routes unbroken | 1 (the URL) and 7 |
| 3. Node.js/Express REST API | 2–3 (code) |
| 4. MySQL via Prisma with migrations | 3 |
| 5. JWT + RBAC with Microsoft AD | 4 (sign-in), 5 (student view), 6 (roles) |
| 6. Secrets from Key Vault, not `.env` | 2 |
| 7. External public API | 4 (Geoapify pin → address) |
| 8. Exposed API-key endpoint | 7 (room status, and the 401) |
| 9. GitHub repository | Show the repo page, if it's pushed by then |
| 10. Automated deployment | 7 (`deploy.sh`, releases and rollback) |

If a requirement can't be shown live, say where it is in the code instead — don't skip it silently.

## If something goes wrong

| Problem | What to do |
|---|---|
| Microsoft asks which account | Pick the AU one; it's a normal prompt, keep talking |
| The Discord message is slow | Keep going; check the tab a few seconds later ("there it is") |
| A page looks stale | Refresh once. Roles only change after a refresh |
| Signed out mid-demo | You were idle 15 minutes; sign in again and carry on |
| The map tiles are slow | Say what the pin does and move on |
| Anything else fails | Say what it should do, and mention it's covered by the automated tests |

## After recording

Thar: set Mi Hsu back to **Organizer** in Admin → People.
