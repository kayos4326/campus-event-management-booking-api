const axios = require("axios");
const { prisma } = require("./prisma");
const outbox = require("./outbox");

// Delivers organizer-selected supply requests to Discord. The event, request and outbox
// job are committed together; the worker retries delivery and stores Discord's message ID.

const JOB_TYPE = "supply.send";
const DISCORD_TIMEOUT_MS = 10000;

// Queue only published requests, inside the transaction that publishes the event.
async function enqueueSupplyRequest(tx, preorder) {
  // Re-publishing must not send an already confirmed request twice.
  if (!preorder || preorder.status === "CONFIRMED") return null;
  // Publishing again gives a failed request a fresh set of attempts.
  if (preorder.status === "FAILED") {
    await tx.merchPreorder.update({ where: { id: preorder.id }, data: { status: "PENDING" } });
  }
  return outbox.enqueue(tx, JOB_TYPE, { preorderId: preorder.id }, { dedupeKey: `supply:${preorder.id}` });
}

function supplyMessage(preorder, event) {
  return `📦 Supply request: ${preorder.quantity} × ${preorder.item} for "${event.title}" (event #${event.id}, ${event.capacity} seats).`;
}

// Return the Discord message ID and classify errors for the retry worker.
async function postToDiscord(content) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  // Missing configuration may be fixed while the durable job remains queued.
  if (!webhook) throw new Error("DISCORD_WEBHOOK_URL isn't set");

  const url = new URL(webhook);
  // `?wait=true` makes Discord return the created message (with its id) instead of 204.
  url.searchParams.set("wait", "true");

  try {
    const { data } = await axios.post(url.toString(), { content }, { timeout: DISCORD_TIMEOUT_MS });
    return data?.id ?? null;
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) {
      // Respect Discord's requested delay when rate limited.
      const seconds = Number(err.response.data?.retry_after ?? err.response.headers?.["retry-after"]);
      throw new outbox.RetryLaterError("Discord rate limit (HTTP 429)", Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined);
    }
    if (status >= 400 && status < 500) {
      // Retrying a rejected request without changing it cannot succeed.
      throw new outbox.PermanentError(`Discord refused the message (HTTP ${status})`);
    }
    throw new Error(status ? `Discord answered HTTP ${status}` : `Couldn't reach Discord (${err.code || "network error"})`);
  }
}

// Re-read state on every attempt so confirmed or cancelled requests are not sent.
async function deliverSupplyRequest({ preorderId }) {
  const preorder = await prisma.merchPreorder.findUnique({ where: { id: preorderId }, include: { event: true } });
  if (!preorder) return "skipped: the supply order no longer exists";
  if (preorder.status === "CONFIRMED") return "skipped: already sent";
  // Unpublished or cancelled while the job waited. Publishing again queues a new one.
  if (preorder.event.status !== "PUBLISHED") return `skipped: the event is ${preorder.event.status.toLowerCase()}`;

  const messageId = await postToDiscord(supplyMessage(preorder, preorder.event));
  await prisma.merchPreorder.update({
    where: { id: preorder.id },
    data: { status: "CONFIRMED", peerOrderRef: messageId },
  });
  return `sent: Discord message ${messageId}`;
}

// Given up on: the organizer's list shows "(not sent)", and publishing again retries.
async function markSupplyRequestFailed({ preorderId }) {
  await prisma.merchPreorder.updateMany({
    where: { id: preorderId, status: { not: "CONFIRMED" } },
    data: { status: "FAILED" },
  });
}

outbox.registerHandler(JOB_TYPE, { run: deliverSupplyRequest, onDead: markSupplyRequestFailed });

module.exports = { JOB_TYPE, enqueueSupplyRequest, deliverSupplyRequest, markSupplyRequestFailed };
