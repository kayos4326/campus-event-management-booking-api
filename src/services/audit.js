const { prisma } = require("./prisma");
const { cleanNameOf } = require("../utils/http");

// Records who changed what, for the Admin activity view and each event's history.
// Writing an audit entry must never break the action it describes, so failures are
// swallowed — a lost log line is better than a failed cancellation.
async function record(actor, { action, entityType, entityId, summary }) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: actor?.id ?? null,
        actorLabel: cleanNameOf(actor),
        action,
        entityType,
        entityId: entityId ?? null,
        summary,
      },
    });
  } catch (err) {
    console.error("audit log failed:", err.message);
  }
}

// Lists the changed fields in a human sentence: "capacity 10 → 25, title changed".
function describeChanges(before, after) {
  const parts = [];
  if (after.title !== undefined && after.title !== before.title) parts.push(`title "${before.title}" → "${after.title}"`);
  if (after.capacity !== undefined && after.capacity !== before.capacity) parts.push(`capacity ${before.capacity} → ${after.capacity}`);
  if (after.status !== undefined && after.status !== before.status) parts.push(`${String(before.status).toLowerCase()} → ${String(after.status).toLowerCase()}`);
  if (after.startsAt !== undefined && String(after.startsAt) !== String(before.startsAt)) parts.push("start time changed");
  if (after.endsAt !== undefined && String(after.endsAt) !== String(before.endsAt)) parts.push("end time changed");
  if (after.description !== undefined && after.description !== before.description) parts.push("description changed");
  return parts.join(", ");
}

module.exports = { record, describeChanges };
