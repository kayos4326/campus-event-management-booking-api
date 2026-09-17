jest.mock("axios");
jest.mock("../../src/services/prisma", () => ({
  prisma: { merchPreorder: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() } },
}));

const axios = require("axios");
const { prisma } = require("../../src/services/prisma");
const outbox = require("../../src/services/outbox");
const {
  JOB_TYPE,
  enqueueSupplyRequest,
  deliverSupplyRequest,
  markSupplyRequestFailed,
} = require("../../src/services/merch");

const order = (overrides = {}) => ({
  id: 1,
  item: "Water bottles",
  quantity: 120,
  status: "PENDING",
  event: { id: 7, title: "Tech Conference", capacity: 300, status: "PUBLISHED" },
  ...overrides,
});

const httpError = (status, data = {}, headers = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data, headers } });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DISCORD_WEBHOOK_URL = "https://discord.test/api/webhooks/1/secret-token";
});

describe("enqueueSupplyRequest (runs inside the route's transaction)", () => {
  const tx = { merchPreorder: { update: jest.fn() } };
  let enqueue;
  beforeEach(() => {
    tx.merchPreorder.update.mockReset();
    enqueue = jest.spyOn(outbox, "enqueue").mockResolvedValue({ id: 50 });
  });
  afterEach(() => enqueue.mockRestore());

  test("queues one job per order, with a key that stops duplicates", async () => {
    await enqueueSupplyRequest(tx, order());

    expect(enqueue).toHaveBeenCalledWith(tx, JOB_TYPE, { preorderId: 1 }, { dedupeKey: "supply:1" });
  });

  // Publishing, unpublishing and publishing again must not order the supplies twice.
  test("an order that was already sent isn't queued again", async () => {
    expect(await enqueueSupplyRequest(tx, order({ status: "CONFIRMED" }))).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("an order that was given up on gets a fresh try, back to PENDING", async () => {
    await enqueueSupplyRequest(tx, order({ status: "FAILED" }));

    expect(tx.merchPreorder.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { status: "PENDING" } });
    expect(enqueue).toHaveBeenCalled();
  });

  test("an event without a supply order queues nothing", async () => {
    expect(await enqueueSupplyRequest(tx, null)).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("deliverSupplyRequest (the outbox handler)", () => {
  test("posts the item and amount to Discord and stores the message id", async () => {
    prisma.merchPreorder.findUnique.mockResolvedValue(order());
    axios.post.mockResolvedValue({ data: { id: "1549433934344093887" } });

    const note = await deliverSupplyRequest({ preorderId: 1 });

    const [url, body, options] = axios.post.mock.calls[0];
    expect(url).toBe("https://discord.test/api/webhooks/1/secret-token?wait=true"); // ?wait=true returns the message
    expect(body.content).toContain("120 × Water bottles");
    expect(body.content).toContain("Tech Conference");
    // A hung request would otherwise hold the job until its lease runs out.
    expect(options.timeout).toBeGreaterThan(0);
    expect(prisma.merchPreorder.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: "CONFIRMED", peerOrderRef: "1549433934344093887" },
    });
    expect(note).toMatch(/sent/);
  });

  test("a retry never sends an order that already went through", async () => {
    prisma.merchPreorder.findUnique.mockResolvedValue(order({ status: "CONFIRMED" }));

    expect(await deliverSupplyRequest({ preorderId: 1 })).toMatch(/already sent/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test("an event unpublished or cancelled while the job waited orders nothing", async () => {
    prisma.merchPreorder.findUnique.mockResolvedValue(order({ event: { ...order().event, status: "CANCELLED" } }));

    expect(await deliverSupplyRequest({ preorderId: 1 })).toMatch(/cancelled/);
    expect(axios.post).not.toHaveBeenCalled();
    expect(prisma.merchPreorder.update).not.toHaveBeenCalled();
  });

  test("an order deleted in the meantime is skipped, not an error", async () => {
    prisma.merchPreorder.findUnique.mockResolvedValue(null);

    expect(await deliverSupplyRequest({ preorderId: 1 })).toMatch(/no longer exists/);
  });

  test("Discord being unreachable throws a retryable error and leaves the order PENDING", async () => {
    prisma.merchPreorder.findUnique.mockResolvedValue(order());
    axios.post.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));

    const error = await deliverSupplyRequest({ preorderId: 1 }).catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(outbox.PermanentError);
    expect(prisma.merchPreorder.update).not.toHaveBeenCalled();
  });

  test("a Discord 5xx is retryable", async () => {
    prisma.merchPreorder.findUnique.mockResolvedValue(order());
    axios.post.mockRejectedValue(httpError(503));

    const error = await deliverSupplyRequest({ preorderId: 1 }).catch((err) => err);

    expect(error.message).toMatch(/503/);
    expect(error).not.toBeInstanceOf(outbox.PermanentError);
  });

  test("a rate limit (429) retries after the time Discord asks for", async () => {
    prisma.merchPreorder.findUnique.mockResolvedValue(order());
    axios.post.mockRejectedValue(httpError(429, { retry_after: 2.5 }));

    const error = await deliverSupplyRequest({ preorderId: 1 }).catch((err) => err);

    expect(error).toBeInstanceOf(outbox.RetryLaterError);
    expect(error.retryAfterMs).toBe(2500);
  });

  test("a 4xx such as a deleted webhook is permanent — retrying can't fix it", async () => {
    prisma.merchPreorder.findUnique.mockResolvedValue(order());
    axios.post.mockRejectedValue(httpError(404));

    await expect(deliverSupplyRequest({ preorderId: 1 })).rejects.toBeInstanceOf(outbox.PermanentError);
  });

  test("error messages never contain the webhook URL, which is a credential", async () => {
    prisma.merchPreorder.findUnique.mockResolvedValue(order());
    for (const failure of [httpError(404), httpError(503), httpError(429, {}), Object.assign(new Error("boom https://discord.test/api/webhooks/1/secret-token"), { code: "ETIMEDOUT" })]) {
      axios.post.mockRejectedValueOnce(failure);
      const error = await deliverSupplyRequest({ preorderId: 1 }).catch((err) => err);
      expect(error.message).not.toContain("secret-token");
    }
  });

  test("a missing webhook setting is retryable, so fixing it lets queued orders through", async () => {
    delete process.env.DISCORD_WEBHOOK_URL;
    prisma.merchPreorder.findUnique.mockResolvedValue(order());

    const error = await deliverSupplyRequest({ preorderId: 1 }).catch((err) => err);

    expect(error.message).toMatch(/DISCORD_WEBHOOK_URL/);
    expect(error).not.toBeInstanceOf(outbox.PermanentError);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe("markSupplyRequestFailed (when the outbox gives up)", () => {
  test("marks the order FAILED, but never one that was sent", async () => {
    await markSupplyRequestFailed({ preorderId: 1 });

    expect(prisma.merchPreorder.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: { not: "CONFIRMED" } },
      data: { status: "FAILED" },
    });
  });
});
