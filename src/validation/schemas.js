// What every route accepts, in one file. Messages are written for people: the frontend
// shows `error` straight to the organizer or student (see ./validate.js).
const { z } = require("zod");

const MAX_ID = 2147483647; // MySQL INT — anything larger can't be a row id
const MAX_CAPACITY = 100000;
const MAX_SUPPLY_QUANTITY = 100000;
const VARCHAR = 191; // Prisma's default String column length on MySQL

const EVENT_STATUSES = ["DRAFT", "PUBLISHED", "CANCELLED"];
const ROLES = ["STUDENT", "ORGANIZER", "ADMIN"];

// Body schemas: a JSON array or a bare string isn't a request anyone meant to send.
const body = (shape) => z.object(shape, { error: "Send the request body as a JSON object" });

// "Missing required event fields: title" when a required field is absent, else `message`.
const absentOr = (missing, message) => (issue) =>
  (issue.input === undefined || issue.input === null) && missing ? missing : message;

// ---------------------------------------------------------------------------------- ids

// `/events/abc` names nothing, so a bad id in the URL is a 404 like any missing record.
const idParam = (message = "Not found") =>
  z
    .string()
    .regex(/^[1-9]\d{0,9}$/, message)
    .transform(Number)
    .refine((id) => id <= MAX_ID, message);

const idParams = z.object({ id: idParam() });

// An id sent in a body — accepts 7 or "7". `notFound` makes a malformed one a 404.
const idValue = ({ missing, invalid, notFound = false }) =>
  z
    .union([z.number(), z.string()], { error: absentOr(missing, invalid) })
    .transform((value, ctx) => {
      const id = typeof value === "number" ? value : /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
      if (!Number.isInteger(id) || id < 1 || id > MAX_ID) {
        ctx.addIssue({ code: "custom", message: invalid, ...(notFound && { params: { status: 404 } }) });
        return z.NEVER;
      }
      return id;
    });

// ------------------------------------------------------------------------ small pieces

// `new Date("garbage")` doesn't throw — it's an Invalid Date Prisma later rejects with a 500.
const dateValue = (label, missing) =>
  z
    .union([z.string(), z.number()], { error: absentOr(missing, `${label} must be a valid date`) })
    .transform((value, ctx) => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        ctx.addIssue({ code: "custom", message: `${label} must be a valid date` });
        return z.NEVER;
      }
      return date;
    });

const CAPACITY_MESSAGE = "Capacity must be a whole number of at least 1";
// Strictly a number: "5" is rejected, since a string here means a client bug.
const capacityValue = (missing) =>
  z
    .number({ error: absentOr(missing, CAPACITY_MESSAGE) })
    .int({ error: CAPACITY_MESSAGE })
    .min(1, CAPACITY_MESSAGE)
    .max(MAX_CAPACITY, `Capacity can't be more than ${MAX_CAPACITY}`);

// Free text that may be left out; "" is stored as null.
const optionalText = (max, label) =>
  z.preprocess(
    (value) => (typeof value === "number" ? String(value) : value),
    z
      .string({ error: `${label} must be text` })
      .trim()
      .max(max, `Keep the ${label.toLowerCase()} under ${max} characters`)
      .transform((value) => value || null)
      .nullable()
      .optional()
  );

// "" and null mean "not given"; a numeric string from a form is accepted.
const looseNumber = (value) => {
  if (value === "" || value === null) return undefined;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return value;
};

// ---------------------------------------------------------------------------- events

const SUPPLY_ITEM_MESSAGE = "Say what to order (for example: Blank lanyards)";
const SUPPLY_QUANTITY_MESSAGE = `How many? Use a whole number between 1 and ${MAX_SUPPLY_QUANTITY}`;

// An optional supply order: what to order and how many. Amount defaults to one per seat.
const supplyValue = z.preprocess(
  (value) => (value === "" || value === null ? undefined : value),
  z
    .object(
      {
        item: z
          .string({ error: SUPPLY_ITEM_MESSAGE })
          .trim()
          .min(1, SUPPLY_ITEM_MESSAGE)
          .max(100, "Keep the supply item under 100 characters"),
        quantity: z.preprocess(
          looseNumber,
          z
            .number({ error: SUPPLY_QUANTITY_MESSAGE })
            .int({ error: SUPPLY_QUANTITY_MESSAGE })
            .min(1, SUPPLY_QUANTITY_MESSAGE)
            .max(MAX_SUPPLY_QUANTITY, SUPPLY_QUANTITY_MESSAGE)
            .optional()
        ),
      },
      { error: SUPPLY_ITEM_MESSAGE }
    )
    .optional()
);

const endsAfterStart = (event, ctx) => {
  if (event.startsAt && event.endsAt && event.endsAt <= event.startsAt) {
    ctx.addIssue({ code: "custom", path: ["endsAt"], message: "The event must end after it starts" });
  }
};

const missingEvent = (field) => `Missing required event fields: ${field}`;

const eventCreate = body({
  title: z
    .string({ error: absentOr(missingEvent("title"), "Title must be text") })
    .trim()
    .min(1, "Title can't be empty")
    .max(VARCHAR, `Keep the title under ${VARCHAR} characters`),
  description: optionalText(5000, "Description"),
  startsAt: dateValue("Start time", missingEvent("startsAt")),
  endsAt: dateValue("End time", missingEvent("endsAt")),
  capacity: capacityValue(missingEvent("capacity")),
  venueId: idValue({ missing: missingEvent("venueId"), invalid: "That venue doesn't exist" }),
  status: z.enum(["DRAFT", "PUBLISHED"], { error: "status must be DRAFT or PUBLISHED" }).optional(),
  supply: supplyValue,
})
  .superRefine(endsAfterStart)
  .transform((event) => ({
    ...event,
    status: event.status ?? "DRAFT",
    supply: event.supply ? { item: event.supply.item, quantity: event.supply.quantity ?? event.capacity } : null,
  }));

// Every field optional; checks that need the stored event (end vs. the existing start,
// capacity vs. seats already confirmed) happen in the route, inside its transaction.
const eventUpdate = body({
  title: z
    .string({ error: "Title can't be empty" })
    .trim()
    .min(1, "Title can't be empty")
    .max(VARCHAR, `Keep the title under ${VARCHAR} characters`)
    .optional(),
  description: optionalText(5000, "Description"),
  startsAt: dateValue("Start time").optional(),
  endsAt: dateValue("End time").optional(),
  capacity: capacityValue(CAPACITY_MESSAGE).optional(),
  status: z.enum(EVENT_STATUSES, { error: `status must be one of ${EVENT_STATUSES.join(", ")}` }).optional(),
}).superRefine(endsAfterStart);

const flag = z.enum(["true", "false"], { error: "Use true or false" }).optional().transform((v) => v === "true");

const eventList = z.object({ mine: flag });

const imageParams = z.object({
  id: idParam("Image not found"),
  key: z.string().regex(/^[0-9a-f]{24}$/, "Image not found"),
});

// ---------------------------------------------------------------------------- venues

const PIN_MESSAGE = "Drop a pin on the map to set where the venue is";
const coordinate = (min, max) =>
  z.preprocess(looseNumber, z.number({ error: PIN_MESSAGE }).min(min, PIN_MESSAGE).max(max, PIN_MESSAGE));

const venueCreate = body({
  name: z
    .string({ error: "Venue name is required" })
    .trim()
    .min(1, "Venue name is required")
    .max(VARCHAR, `Keep the venue name under ${VARCHAR} characters`),
  roomNumber: optionalText(VARCHAR, "Room number"),
  addressRaw: optionalText(VARCHAR, "Address label"),
  latitude: coordinate(-90, 90),
  longitude: coordinate(-180, 180),
});

// Editing a venue changes its labels only. The pin deliberately stays put: every event
// already at this venue points at these coordinates, so moving it would quietly relocate
// events that were arranged around the old spot. Correcting a typo is the common case.
const venueUpdate = body({
  name: z
    .string({ error: "Venue name must be text" })
    .trim()
    .min(1, "Venue name is required")
    .max(VARCHAR, `Keep the venue name under ${VARCHAR} characters`)
    .optional(),
  roomNumber: optionalText(VARCHAR, "Room number"),
  addressRaw: optionalText(VARCHAR, "Address label"),
}).refine((value) => Object.keys(value).length > 0, { error: "Change something first" });

const venueList = z.object({ includeArchived: flag });

const SEARCH_MESSAGE = "Type at least 3 characters to search";
const geocodeQuery = z.object({
  q: z.string({ error: SEARCH_MESSAGE }).trim().min(3, SEARCH_MESSAGE).max(200, "Keep the search under 200 characters"),
});

// --------------------------------------------------------------------------- bookings

// A malformed event id identifies no event: 404, same as an event that doesn't exist.
const bookingCreate = body({
  eventId: idValue({ missing: "eventId is required", invalid: "Event not found", notFound: true }),
});

// ------------------------------------------------------------------------------ admin

const roleChange = body({
  role: z.enum(ROLES, { error: `Role must be one of ${ROLES.join(", ")}` }),
});

const apiKeyCreate = body({
  ownerLabel: z
    .string({ error: "Say who the key is for" })
    .trim()
    .min(1, "Say who the key is for")
    .max(VARCHAR, `Keep the label under ${VARCHAR} characters`),
  scope: z
    .string({ error: "A scope is required, e.g. room-status:read" })
    .trim()
    .min(1, "A scope is required, e.g. room-status:read")
    .max(100, "Keep the scope under 100 characters"),
});

const LIMIT_MESSAGE = "limit must be a whole number between 1 and 500";
const BEFORE_MESSAGE = "before must be the id of an activity entry";
const auditQuery = z.object({
  limit: z.preprocess(looseNumber, z.number({ error: LIMIT_MESSAGE }).int(LIMIT_MESSAGE).min(1, LIMIT_MESSAGE).max(500, LIMIT_MESSAGE).default(100)),
  // One page older: the id of the oldest entry already on screen. Ids are handed out in
  // order, so "older than this one" is the next page — and unlike an offset it can't skip
  // or repeat a row when something new is written while someone is reading.
  before: z.preprocess(
    looseNumber,
    z.number({ error: BEFORE_MESSAGE }).int(BEFORE_MESSAGE).min(1, BEFORE_MESSAGE).max(MAX_ID, BEFORE_MESSAGE).optional()
  ),
});

// ------------------------------------------------------------------------------- peer

const roomQuery = z.object({
  room: z.string({ error: "room query param is required" }).trim().min(1, "room query param is required").max(VARCHAR),
});

module.exports = {
  idParams,
  imageParams,
  eventCreate,
  eventUpdate,
  eventList,
  venueCreate,
  venueUpdate,
  venueList,
  geocodeQuery,
  bookingCreate,
  roleChange,
  apiKeyCreate,
  auditQuery,
  roomQuery,
};
