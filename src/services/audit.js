const { prisma } = require("./prisma");
const { cleanNameOf } = require("../utils/http");

// Audit failures are logged but do not cancel the user's action.
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

// Build the short message shown in event history.
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
