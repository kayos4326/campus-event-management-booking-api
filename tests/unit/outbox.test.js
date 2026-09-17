jest.mock("../../src/services/prisma", () => ({
  prisma: { outboxJob: { updateMany: jest.fn() } },
}));

const { prisma } = require("../../src/services/prisma");
const outbox = require("../../src/services/outbox");

// A job as claim() hands it over: attempts already counted, owned by a lock token.
const claimed = (overrides = {}) => ({
  id: 3,
  type: "test.job",
  payload: { n: 1 },
  attempts: 1,
  maxAttempts: 5,
  lockToken: "token-a",
  status: "PROCESSING",
  ...overrides,
});

const recorded = () => prisma.outboxJob.updateMany.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  prisma.outboxJob.updateMany.mockResolvedValue({ count: 1 });
  process.env.OUTBOX_BASE_DELAY_MS = "1000";
  process.env.OUTBOX_MAX_DELAY_MS = "60000";
});

describe("enqueue (inside the caller's transaction)", () => {
  const tx = { outboxJob: { findFirst: jest.fn(), create: jest.fn() } };
  beforeEach(() => {
    tx.outboxJob.findFirst.mockReset();
    tx.outboxJob.create.mockReset().mockImplementation(async ({ data }) => ({ id: 9, ...data }));
  });

  test("writes the job with the transaction client it was given", async () => {
    tx.outboxJob.findFirst.mockResolvedValue(null);

    const job = await outbox.enqueue(tx, "supply.send", { preorderId: 4 }, { dedupeKey: "supply:4" });

    expect(job).toEqual(expect.objectContaining({ id: 9, type: "supply.send", payload: { preorderId: 4 }, dedupeKey: "supply:4" }));
  });

  test("reuses a job for the same key that's still waiting or running", async () => {
    tx.outboxJob.findFirst.mockResolvedValue({ id: 2 });

    expect(await outbox.enqueue(tx, "supply.send", { preorderId: 4 }, { dedupeKey: "supply:4" })).toEqual({ id: 2 });
    expect(tx.outboxJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { dedupeKey: "supply:4", status: { in: ["PENDING", "PROCESSING"] } } })
    );
    expect(tx.outboxJob.create).not.toHaveBeenCalled();
  });
});

describe("backoff", () => {
  test("doubles with each attempt, within ±20%", () => {
    for (const [attempt, base] of [[1, 1000], [2, 2000], [3, 4000], [5, 16000]]) {
      const delay = outbox.backoffMs(attempt);
      expect(delay).toBeGreaterThanOrEqual(base * 0.8);
      expect(delay).toBeLessThanOrEqual(base * 1.2);
    }
  });

  test("is capped", () => {
    expect(outbox.backoffMs(40)).toBeLessThanOrEqual(60000 * 1.2);
  });
});

describe("runJob", () => {
  let run;
  let onDead;
  beforeEach(() => {
    run = jest.fn();
    onDead = jest.fn();
    outbox.registerHandler("test.job", { run, onDead });
  });

  test("success: DONE, with the handler's note, and the claim released", async () => {
    run.mockResolvedValue("sent: 42");

    const result = await outbox.runJob(claimed());

    expect(run).toHaveBeenCalledWith({ n: 1 }, expect.objectContaining({ id: 3 }));
    expect(recorded().where).toEqual({ id: 3, lockToken: "token-a", status: "PROCESSING" });
    expect(recorded().data).toEqual(expect.objectContaining({ status: "DONE", note: "sent: 42", lockToken: null, lockedUntil: null }));
    expect(result).toEqual(expect.objectContaining({ status: "DONE", recorded: true }));
  });

  test("a temporary failure goes back to PENDING, due after a backoff", async () => {
    run.mockRejectedValue(new Error("Discord answered HTTP 503"));
    const before = Date.now();

    await outbox.runJob(claimed({ attempts: 2 }));

    const { data } = recorded();
    expect(data.status).toBe("PENDING");
    expect(data.lastError).toBe("Discord answered HTTP 503");
    expect(data.runAt.getTime() - before).toBeGreaterThanOrEqual(2000 * 0.8);
    expect(data.runAt.getTime() - before).toBeLessThanOrEqual(2000 * 1.2 + 50);
    expect(onDead).not.toHaveBeenCalled();
  });

  test("a rate limit waits exactly as long as asked", async () => {
    run.mockRejectedValue(new outbox.RetryLaterError("429", 7000));
    const before = Date.now();

    await outbox.runJob(claimed());

    expect(recorded().data.runAt.getTime() - before).toBeGreaterThanOrEqual(7000);
    expect(recorded().data.runAt.getTime() - before).toBeLessThan(7100);
  });

  test("a permanent error is DEAD straight away, and the handler is told", async () => {
    const error = new outbox.PermanentError("Discord refused the message (HTTP 404)");
    run.mockRejectedValue(error);

    await outbox.runJob(claimed({ attempts: 1, maxAttempts: 8 }));

    expect(recorded().data.status).toBe("DEAD");
    expect(onDead).toHaveBeenCalledWith({ n: 1 }, error);
  });

  test("the last attempt failing is DEAD too", async () => {
    run.mockRejectedValue(new Error("still down"));

    await outbox.runJob(claimed({ attempts: 5, maxAttempts: 5 }));

    expect(recorded().data.status).toBe("DEAD");
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  // The worker was so slow its lease expired and another worker took the job over.
  test("a claim that no longer owns the job records nothing and doesn't call onDead", async () => {
    prisma.outboxJob.updateMany.mockResolvedValue({ count: 0 });
    run.mockRejectedValue(new outbox.PermanentError("nope"));

    const result = await outbox.runJob(claimed());

    expect(result.recorded).toBe(false);
    expect(onDead).not.toHaveBeenCalled();
  });

  test("a job type nobody handles is DEAD, not retried forever", async () => {
    await outbox.runJob(claimed({ type: "no.such.job" }));

    expect(recorded().data).toEqual(expect.objectContaining({ status: "DEAD", lastError: expect.stringMatching(/No handler/) }));
  });

  test("onDead failing doesn't break the worker", async () => {
    run.mockRejectedValue(new outbox.PermanentError("nope"));
    onDead.mockRejectedValue(new Error("db down"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(outbox.runJob(claimed())).resolves.toEqual(expect.objectContaining({ status: "DEAD" }));
    console.error.mockRestore();
  });
});

describe("kick", () => {
  test("does nothing while the worker isn't running (tests, scripts)", () => {
    expect(() => outbox.kick()).not.toThrow();
  });
});
