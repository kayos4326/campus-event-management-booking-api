![](media/0aa0287d31471409eea11c0b73968018e8505c3e.png){width="2.7083333333333335in"
height="2.6666666666666665in"}

**A S S U M P T I O N U N I V E R S I T Y O F T H A I L A N D**

**Campus Event Management and Booking API**

**Arjan Dr. CHAYAPOL MOEMENG**

**Group Members**

Thar Lin Htet (6642062)

Honey Linn (6726113)

Mi Hsu Myat Win Wyint (6726115)

**Project Overview**

The Campus Event Management and Booking API is a backend application
that lets university organizations create events and lets students book
seats for those events.

Organizers and students will log in using their university Microsoft
accounts. Organizers can create events with a venue, schedule, and seat
capacity. Students can browse published events and RSVP. When an event
is full, new students are added to a waitlist.

The system also checks that every venue address is a real place using a
geocoding API, and connects with two other teams in the class through
peer APIs: it orders lanyards from the Merchandise Store system for
large conferences, and it lets the HelpDesk system check if an event is
happening in a room.

**Problem Statement**

Event sign-ups at university are usually done with Google Forms, chat
groups, or paper lists. There is no seat limit control, students can
register twice, and venue information is typed by hand so it is often
wrong or unclear.

Organizers of big events also have to arrange attendee items like
lanyards manually, and the IT helpdesk has no way to know if a broken
projector is affecting an event that is happening right now.

A centralized booking system with real authentication, capacity control,
and connections to other campus services would solve these problems.

**Project Objectives**

- Provide a central platform for creating events and booking seats.

- Authenticate users with Microsoft Active Directory (Entra ID).

- Protect endpoints using JWT authentication and Role-Based Access
  Control.

- Enforce seat capacity, waitlists, and one booking per student per
  event.

- Validate venue addresses and generate map links using the Geoapify
  API.

- Order lanyards automatically through the Merchandise team\'s API for
  large conferences.

- Expose a protected endpoint so the HelpDesk team can check for active
  events in a room.

- Store production secrets in Azure Key Vault.

- Deploy on a hardened Linux VPS using Nginx and HTTPS under a new
  /events path.

**Main Features**

**Organizer**

- Log in using a university Microsoft account.

- Create, update, and cancel their own events.

- Set the venue, schedule, and seat capacity.

- Mark an event as a large conference (this triggers the lanyard
  pre-order).

- View the attendee list and booking count of their own events.

**Student**

- Log in using a university Microsoft account.

- Browse and search published events.

- RSVP to reserve a seat, or join the waitlist when the event is full.

- Cancel their own bookings and view their booking history.

**Administrator**

- Manage users and roles.

- Issue and revoke peer API keys.

- View all events and bookings.

**Role-Based Access Control**

The system will use three roles:

- Student

- Organizer

- Admin

Students can only manage their own bookings. Organizers can only manage
events they created (the system checks organizer_id on every update).
Admins can manage everything, including users, roles, and peer API keys.
Every request must include a JWT, and a middleware checks the role
before the request is allowed. The peer endpoint for the HelpDesk team
does not use JWT --- it is protected by an API key instead.

**External API Integration (Geoapify)**

The system will use the Geoapify API for geocoding and static maps.
Geoapify has a free tier (3,000 requests per day) and does not require a
credit card, which fits a student project.

When an organizer creates an event, the backend sends the venue address
to the Geoapify Geocoding API. If the address does not resolve to a real
place, the event is rejected. If it does, the coordinates are saved and
a static map image URL is generated and stored with the venue.

**Example input:**

Assumption University, Bang Na, Samut Prakan

**Example result:**

{

\"lat\": 13.6120,

\"lon\": 100.8367,

\"confidence\": 0.95,

\"static_map_url\":
\"https://maps.geoapify.com/v1/staticmap?\...&marker=\...\"

}

An organizer can still correct the venue name manually, but the
coordinates always come from the geocoder.

**Peer API Integration**

Our project connects with two other teams, because the class projects
call each other in a chain.

**API Consumed --- Merchandise Store (Option 1)**

When an organizer creates an event marked as a large conference, our
backend automatically calls the Merchandise team\'s API to pre-order 50
blank university lanyards for the attendees. We authenticate with the
API key that their team issues to us.

POST /orders

x-api-key: MERCH_API_KEY

{ \"item\": \"lanyard\", \"quantity\": 50, \"reference\":
\"\<eventId\>\" }

The order reference from their response is saved in our merch_preorders
table so we can show the pre-order status.

**API Exposed --- room check for HelpDesk (Option 2)**

The HelpDesk team will call our API to check whether an event is
currently happening in a room, so they can mark tickets like \"the
projector in Room 402 is broken\" as URGENT. We generate an API key and
issue it only to their team. The key is stored as a hash in our
database.

GET /events/api/peer/events/active?room=402

x-api-key: HELPDESK_TEAM_KEY

Response:

{ \"active\": true, \"eventId\": 12, \"title\": \"Tech Summit 2026\",
\"endsAt\": \"2026-11-05T16:00:00Z\" }

The request uses a room number because that is what the HelpDesk system
knows from the ticket text. Our venues table has a room_number column
for this lookup. The exact path will be confirmed with the HelpDesk team
before development starts.

**Database Schema (ERD)**

The database has six tables. A user can be an organizer of events and a
student in bookings at the same time, so the User table connects to
both. The ApiKey table stores the hashed keys we issue to peer teams.

![](media/da58f3826e411708403d537ab7c9e85cbbc9073d.png){width="6.458333333333333in"
height="3.8854166666666665in"}

**Relationships**

- User 1 ───── Many Events (as organizer)

- Venue 1 ───── Many Events

- Event 1 ───── Many Bookings

- User 1 ───── Many Bookings (as student, one booking per event)

- Event 1 ───── 0..1 MerchPreorder (only large conferences)

**Prisma schema**

We manage the database with Prisma migrations. This is the planned
schema:

generator client {

provider = \"prisma-client-js\"

}

datasource db {

provider = \"mysql\"

url = env(\"DATABASE_URL\") // injected at runtime from Key Vault

}

enum Role { STUDENT ORGANIZER ADMIN }

enum EventStatus { DRAFT PUBLISHED CANCELLED }

enum BookingStatus { CONFIRMED WAITLISTED CANCELLED }

enum PreorderStatus { PENDING CONFIRMED FAILED }

model User {

id Int \@id \@default(autoincrement())

adObjectId String \@unique \@map(\"ad_object_id\") // Entra \'oid\'
claim

email String \@unique

displayName String \@map(\"display_name\")

role Role \@default(STUDENT)

createdAt DateTime \@default(now()) \@map(\"created_at\")

eventsOrganized Event\[\] \@relation(\"Organizer\")

bookings Booking\[\]

@@map(\"users\")

}

model Venue {

id Int \@id \@default(autoincrement())

name String

roomNumber String? \@map(\"room_number\") // e.g. \"402\" - used by
HelpDesk lookup

addressRaw String \@map(\"address_raw\")

latitude Float? // set after geocoding

longitude Float?

staticMapUrl String? \@map(\"static_map_url\")

isVerified Boolean \@default(false) \@map(\"is_verified\")

events Event\[\]

@@map(\"venues\")

}

model Event {

id Int \@id \@default(autoincrement())

organizerId Int \@map(\"organizer_id\")

venueId Int \@map(\"venue_id\")

title String

description String? \@db.Text

capacity Int

startsAt DateTime \@map(\"starts_at\")

endsAt DateTime \@map(\"ends_at\")

isLargeConference Boolean \@default(false)
\@map(\"is_large_conference\")

status EventStatus \@default(DRAFT)

createdAt DateTime \@default(now()) \@map(\"created_at\")

organizer User \@relation(\"Organizer\", fields: \[organizerId\],
references: \[id\])

venue Venue \@relation(fields: \[venueId\], references: \[id\])

bookings Booking\[\]

preorder MerchPreorder?

@@index(\[venueId\])

@@index(\[organizerId\])

@@map(\"events\")

}

model Booking {

id Int \@id \@default(autoincrement())

eventId Int \@map(\"event_id\")

studentId Int \@map(\"student_id\")

status BookingStatus \@default(CONFIRMED)

createdAt DateTime \@default(now()) \@map(\"created_at\")

event Event \@relation(fields: \[eventId\], references: \[id\])

student User \@relation(fields: \[studentId\], references: \[id\])

@@unique(\[eventId, studentId\]) // one booking per student per event

@@map(\"bookings\")

}

model MerchPreorder {

id Int \@id \@default(autoincrement())

eventId Int \@unique \@map(\"event_id\") // 1:0..1 with Event

quantity Int \@default(50)

peerOrderRef String? \@map(\"peer_order_ref\") // ref returned by Merch
API

status PreorderStatus \@default(PENDING)

createdAt DateTime \@default(now()) \@map(\"created_at\")

event Event \@relation(fields: \[eventId\], references: \[id\])

@@map(\"merch_preorders\")

}

model ApiKey {

id Int \@id \@default(autoincrement())

ownerLabel String \@map(\"owner_label\") // e.g. \"ticketing-team\"

keyHash String \@map(\"key_hash\") // store hash, never the raw key

scope String // e.g. \"room-status:read\"

isActive Boolean \@default(true) \@map(\"is_active\")

createdAt DateTime \@default(now()) \@map(\"created_at\")

@@map(\"api_keys\")

}

**Technology Stack**

- Backend: Node.js with Express

- Database: MySQL

- ORM: Prisma ORM with migrations

- Authentication: Microsoft Active Directory (Entra ID, OIDC)

- Authorization: JWT and RBAC

- Secrets Management: Azure Key Vault

- External API: Geoapify (geocoding and static maps)

- Deployment: Azure Linux VPS

- Reverse Proxy: Nginx

- SSL: Let\'s Encrypt

- Source Control: GitHub

- Automation: Deployment script (PM2 and prisma migrate deploy)

**Deployment Plan**

The system will be deployed on our existing hardened Azure Linux VM. The
backend will run on a private port and will be exposed through Nginx
under a separate path:

https://chaotic-hell.eastasia.cloudapp.azure.com/events

The /events route will be a new Nginx location block, so the existing
/content (WordPress) and /api (Lab) routes are not affected.

For secrets, we will keep only non-secret settings in a local env file
(the Key Vault URL, the port, and the Entra tenant and client IDs). The
real secrets --- the database URL, JWT secret, Geoapify key, and peer
API keys --- will be fetched from Azure Key Vault when the app starts,
using the VM\'s managed identity. This way no production secret is ever
saved in a .env file or in the GitHub repository. Because the school
does not provide class credentials, we will create our own free Entra ID
tenant and our own Key Vault for this.

**Expected Outcome**

The completed system will be a working event booking platform for the
university. The project will demonstrate:

- REST API development

- Microsoft Active Directory login

- JWT authentication and Role-Based Access Control

- Prisma ORM and migrations

- Azure Key Vault integration

- Venue validation with a third-party geocoding API

- Peer API communication with two partner teams

- Nginx reverse proxy and HTTPS deployment

- GitHub source control and automated deployment
