const axios = require("axios");
const { prisma } = require("./prisma");
const outbox = require("./outbox");

// Send event supply requests to Discord through the outbox worker.

const JOB_TYPE = "supply.send";
const DISCORD_TIMEOUT_MS = 10000;

// Queue a request when its event is published.
async function enqueueSupplyRequest(tx, preorder) {
  // Do not send an order twice.
  if (!preorder || preorder.status === "CONFIRMED") return null;
  // Publishing again retries a failed order.
  if (preorder.status === "FAILED") {
    await tx.merchPreorder.update({ where: { id: preorder.id }, data: { status: "PENDING" } });
  }
  return outbox.enqueue(tx, JOB_TYPE, { preorderId: preorder.id }, { dedupeKey: `supply:${preorder.id}` });
}

function supplyMessage(preorder, event) {
  return `📦 Supply request: ${preorder.quantity} × ${preorder.item} for "${event.title}" (event #${event.id}, ${event.capacity} seats).`;
}

// Send the message and return its Discord id.
async function postToDiscord(content) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) throw new Error("DISCORD_WEBHOOK_URL isn't set");

  const url = new URL(webhook);
  // Ask Discord to return the created message.
  url.searchParams.set("wait", "true");

  try {
    const { data } = await axios.post(url.toString(), { content }, { timeout: DISCORD_TIMEOUT_MS });
    return data?.id ?? null;
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) {
      // Use Discord's retry delay.
      const seconds = Number(err.response.data?.retry_after ?? err.response.headers?.["retry-after"]);
      throw new outbox.RetryLaterError("Discord rate limit (HTTP 429)", Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined);
    }
    if (status >= 400 && status < 500) {
      // Other 4xx errors need a configuration or request change.
      throw new outbox.PermanentError(`Discord refused the message (HTTP ${status})`);
    }
    throw new Error(status ? `Discord answered HTTP ${status}` : `Couldn't reach Discord (${err.code || "network error"})`);
  }
}

// Check the latest event state before each attempt.
async function deliverSupplyRequest({ preorderId }) {
  const preorder = await prisma.merchPreorder.findUnique({ where: { id: preorderId }, include: { event: true } });
  if (!preorder) return "skipped: the supply order no longer exists";
  if (preorder.status === "CONFIRMED") return "skipped: already sent";
  if (preorder.event.status !== "PUBLISHED") return `skipped: the event is ${preorder.event.status.toLowerCase()}`;

  const messageId = await postToDiscord(supplyMessage(preorder, preorder.event));
  await prisma.merchPreorder.update({
    where: { id: preorder.id },
    data: { status: "CONFIRMED", peerOrderRef: messageId },
  });
  return `sent: Discord message ${messageId}`;
}

// Mark the order failed after its final attempt.
async function markSupplyRequestFailed({ preorderId }) {
  await prisma.merchPreorder.updateMany({
    where: { id: preorderId, status: { not: "CONFIRMED" } },
    data: { status: "FAILED" },
  });
}

outbox.registerHandler(JOB_TYPE, { run: deliverSupplyRequest, onDead: markSupplyRequestFailed });

module.exports = { JOB_TYPE, enqueueSupplyRequest, deliverSupplyRequest, markSupplyRequestFailed };
