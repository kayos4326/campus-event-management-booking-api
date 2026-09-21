const crypto = require("crypto");
const { prisma } = require("./prisma");

// Outbox jobs are saved in the same transaction as the related database change.
// The worker claims due jobs, retries failures and picks up expired leases after a restart.

const settings = () => ({
  pollMs: Number(process.env.OUTBOX_POLL_MS || 5000),
  leaseMs: Number(process.env.OUTBOX_LEASE_MS || 60000),
  baseDelayMs: Number(process.env.OUTBOX_BASE_DELAY_MS || 15000),
  maxDelayMs: Number(process.env.OUTBOX_MAX_DELAY_MS || 60 * 60 * 1000),
  maxAttempts: Number(process.env.OUTBOX_MAX_ATTEMPTS || 8),
  batchSize: 10,
});

// Use this when retrying cannot fix the problem.
class PermanentError extends Error {}

// Use this when the remote service tells us when to retry.
class RetryLaterError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

const handlers = new Map();

function registerHandler(type, handler) {
  handlers.set(type, handler);
}

// A dedupe key prevents two active jobs for the same task.
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

// Exponential delay with a small random offset.
function backoffMs(attempt) {
  const { baseDelayMs, maxDelayMs } = settings();
  const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(delay * (0.8 + Math.random() * 0.4));
}

// Claim due jobs and jobs whose previous worker lease expired.
async function claim(limit) {
  const { leaseMs } = settings();
  const now = new Date();
  const lockToken = crypto.randomUUID();

  return prisma.$transaction(
    async (tx) => {
      // Use one application timestamp for the query and lease.
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
    // Avoid gap locks while workers claim separate rows.
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

  // Ignore a result if another worker already took over the expired lease.
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

// Run jobs one at a time to avoid sending a burst to Discord.
async function processDue({ limit = settings().batchSize } = {}) {
  const jobs = await claim(limit);
  const results = [];
  for (const job of jobs) results.push(await runJob(job));
  return results;
}

// Worker loop

let stopped = true;
let timer = null;
let pass = null;
let again = false;

function schedule(delayMs) {
  clearTimeout(timer);
  timer = setTimeout(tick, delayMs);
  timer.unref();
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
      // Try again on the next poll if the database is temporarily unavailable.
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

// Start a pass as soon as a request commits a new job.
function kick() {
  if (stopped) return;
  if (pass) again = true;
  else schedule(0);
}

// Give the current job a short chance to finish during shutdown.
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
  startWorker,
  stopWorker,
  kick,
};
