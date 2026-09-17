const crypto = require("crypto");
const { prisma } = require("./prisma");

// A transactional outbox: durable, retryable delivery for work that follows a database
// change — today, posting a supply order to Discord (services/merch.js).
//
// 1. The route writes a job with enqueue(tx, …) inside the same transaction as the change,
//    so the job exists exactly when the change does. A crash or a Discord outage can't
//    lose it, and a rolled-back request never sends anything.
// 2. A worker in the app process claims due jobs (FOR UPDATE SKIP LOCKED, so two processes
//    never take the same one) and holds each for a lease while it runs.
// 3. Success marks the job DONE. A failure schedules a retry with exponential backoff; an
//    error retrying can't fix, or running out of attempts, marks it DEAD and tells the
//    handler (onDead) so it can record the failure where people will see it.
// 4. If the process dies mid-job, the lease runs out and another pass picks it up again.
//
// Delivery is at-least-once: if Discord accepts a message and the process dies before the
// job is marked DONE, it is sent again. Handlers re-check their own state first to keep
// that window small.

const settings = () => ({
  pollMs: Number(process.env.OUTBOX_POLL_MS || 5000),
  leaseMs: Number(process.env.OUTBOX_LEASE_MS || 60000),
  baseDelayMs: Number(process.env.OUTBOX_BASE_DELAY_MS || 15000),
  maxDelayMs: Number(process.env.OUTBOX_MAX_DELAY_MS || 60 * 60 * 1000),
  maxAttempts: Number(process.env.OUTBOX_MAX_ATTEMPTS || 8),
  batchSize: 10,
});

// Retrying won't change the answer (e.g. Discord says the webhook doesn't exist).
class PermanentError extends Error {}

// Try again, but not before `retryAfterMs` (e.g. Discord's rate limit says when).
class RetryLaterError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

const handlers = new Map();

// `run(payload, job)` does the work and may return a short note for the job row;
// `onDead(payload, error)` is called once when the job is given up on.
function registerHandler(type, handler) {
  handlers.set(type, handler);
}

// Call with the transaction client of the change that needs the job. With a dedupeKey, a
// job that's still waiting or running for the same key is reused instead of duplicated.
async function enqueue(tx, type, payload, { dedupeKey = null } = {}) {
  if (dedupeKey) {
    const live = await tx.outboxJob.findFirst({
      where: { dedupeKey, status: { in: ["PENDING", "PROCESSING"] } },
      select: { id: true },
    });
    if (live) return live;
  }
  return tx.outboxJob.create({
    data: { type, payload, dedupeKey, maxAttempts: settings().maxAttempts },
  });
}

// 15s, 30s, 1m, 2m … capped at an hour, ±20% so a batch of failures doesn't retry in lockstep.
function backoffMs(attempt) {
  const { baseDelayMs, maxDelayMs } = settings();
  const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(delay * (0.8 + Math.random() * 0.4));
}

// Takes up to `limit` due jobs — new ones whose time has come, and claimed ones whose
// lease ran out because their worker died. The attempt is counted here, at claim time, so
// a job that crashes the process every time still runs out of attempts.
async function claim(limit) {
  const { leaseMs } = settings();
  const now = new Date();
  const lockToken = crypto.randomUUID();

  return prisma.$transaction(
    async (tx) => {
      // Timestamps are passed in rather than using NOW(), so the comparison doesn't depend
      // on the MySQL server's time zone matching the UTC values Prisma writes.
      const rows = await tx.$queryRaw`
        SELECT id FROM outbox_jobs
        WHERE (status = 'PENDING' AND run_at <= ${now})
           OR (status = 'PROCESSING' AND locked_until <= ${now})
        ORDER BY run_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return [];

      const ids = rows.map((row) => Number(row.id));
      await tx.outboxJob.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "PROCESSING",
          lockToken,
          lockedUntil: new Date(now.getTime() + leaseMs),
          attempts: { increment: 1 },
        },
      });
      return tx.outboxJob.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
    },
    // READ COMMITTED: no gap locks, so concurrent claims only ever skip the rows in use.
    { isolationLevel: "ReadCommitted" }
  );
}

async function runJob(job) {
  const handler = handlers.get(job.type);
  let outcome;
  let error;

  try {
    if (!handler) throw new PermanentError(`No handler for job type "${job.type}"`);
    const note = await handler.run(job.payload, job);
    outcome = { status: "DONE", note: note ?? null, lastError: null, completedAt: new Date() };
  } catch (err) {
    error = err;
    const lastError = String(err?.message || err).slice(0, 2000);
    if (err instanceof PermanentError || job.attempts >= job.maxAttempts) {
      outcome = { status: "DEAD", lastError, completedAt: new Date() };
    } else {
      const delay = err instanceof RetryLaterError && err.retryAfterMs > 0 ? err.retryAfterMs : backoffMs(job.attempts);
      outcome = { status: "PENDING", lastError, runAt: new Date(Date.now() + delay) };
    }
  }

  // Only the claim that still owns the job may record what happened. If this worker was
  // so slow the lease ran out and another worker took over, its result is stale.
  const { count } = await prisma.outboxJob.updateMany({
    where: { id: job.id, lockToken: job.lockToken, status: "PROCESSING" },
    data: { ...outcome, lockToken: null, lockedUntil: null },
  });

  if (count === 1 && outcome.status === "DEAD" && handler?.onDead) {
    await Promise.resolve()
      .then(() => handler.onDead(job.payload, error))
      .catch((err) => console.error(`outbox: onDead for job ${job.id} failed:`, err.message));
  }
  return { id: job.id, type: job.type, attempts: job.attempts, recorded: count === 1, ...outcome };
}

// One pass: claim what's due and run it. Jobs run one at a time, which keeps a burst of
// events from tripping Discord's rate limit.
async function processDue({ limit = settings().batchSize } = {}) {
  const jobs = await claim(limit);
  const results = [];
  for (const job of jobs) results.push(await runJob(job));
  return results;
}

// ------------------------------------------------------------------------------ worker

let stopped = true;
let timer = null;
let pass = null; // the pass in progress, if any
let again = false; // a kick() arrived during a pass

function schedule(delayMs) {
  clearTimeout(timer);
  timer = setTimeout(tick, delayMs);
  timer.unref(); // never the reason a process stays alive
}

async function tick() {
  timer = null;
  if (stopped || pass) return;

  pass = (async () => {
    try {
      let results;
      do {
        again = false;
        results = await processDue();
      } while (!stopped && (again || results.length === settings().batchSize));
    } catch (err) {
      // The database being briefly unreachable shouldn't stop the worker for good.
      console.error("outbox: pass failed:", err.message);
    }
  })();
  await pass;
  pass = null;
  if (!stopped) schedule(settings().pollMs);
}

function startWorker() {
  if (!stopped) return;
  stopped = false;
  schedule(0);
}

// Run now rather than at the next poll — called once a request has committed a job.
function kick() {
  if (stopped) return;
  if (pass) again = true;
  else schedule(0);
}

// Stops polling and waits (up to timeoutMs) for the job in progress. Anything unfinished
// is picked up again once its lease runs out.
async function stopWorker({ timeoutMs = 1000 } = {}) {
  stopped = true;
  clearTimeout(timer);
  timer = null;
  if (pass) {
    await Promise.race([pass, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }
}

module.exports = {
  PermanentError,
  RetryLaterError,
  registerHandler,
  enqueue,
  backoffMs,
  claim,
  runJob,
  processDue,
  startWorker,
  stopWorker,
  kick,
};
