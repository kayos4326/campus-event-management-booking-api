// Shared test setup: mocks Prisma (no real DB) and stubs out only the JWT-verification
// part of auth (no real Entra/network call), while keeping the REAL requireRole logic —
// that's exactly the authorization behavior these tests want to exercise.
let mockCurrentUser = { id: 1, role: "STUDENT" };

jest.mock("../../src/middleware/auth", () => {
  const actual = jest.requireActual("../../src/middleware/auth");
  return {
    ...actual,
    requireAuth: (req, res, next) => {
      if (!mockCurrentUser) {
        return res.status(401).json({ error: "Missing bearer token" });
      }
      req.user = mockCurrentUser;
      next();
    },
  };
});

jest.mock("../../src/services/prisma", () => ({
  prisma: {
    venue: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    event: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    booking: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    user: { findMany: jest.fn(), findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
    auditLog: { create: jest.fn(), findMany: jest.fn() },
    apiKey: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    merchPreorder: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    outboxJob: { create: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
    eventImage: { findUnique: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
    // Interactive transactions just run the callback against this same mock client.
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

// Records whether it was called inside a transaction — a queued job must be part of the
// same write as the change that needs it.
jest.mock("../../src/services/merch", () => ({
  enqueueSupplyRequest: jest.fn(),
}));

jest.mock("../../src/services/geoapify", () => ({
  searchPlaces: jest.fn(),
  describeLocation: jest.fn(),
}));

const { createApp } = require("../../src/app");
const { prisma } = require("../../src/services/prisma");
const { searchPlaces, describeLocation } = require("../../src/services/geoapify");
const { enqueueSupplyRequest } = require("../../src/services/merch");

function setUser(user) {
  mockCurrentUser = user;
}

function resetMocks() {
  Object.entries(prisma).forEach(([key, model]) => {
    if (key === "inTransaction") return;
    if (key.startsWith("$")) return model.mockReset();
    Object.values(model).forEach((fn) => fn.mockReset());
  });
  // Interactive transactions run the callback against this same mock client, and note
  // that they're inside one.
  prisma.$transaction.mockImplementation(async (fn) => {
    prisma.inTransaction = true;
    try {
      return await fn(prisma);
    } finally {
      prisma.inTransaction = false;
    }
  });
  prisma.$queryRaw.mockResolvedValue([]);
  // Seat-bookkeeping defaults: no confirmed seats and nobody waitlisted, unless a test says so.
  prisma.booking.count.mockResolvedValue(0);
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.booking.groupBy.mockResolvedValue([]);
  prisma.booking.updateMany.mockResolvedValue({ count: 0 });
  searchPlaces.mockReset();
  describeLocation.mockReset();
  enqueueSupplyRequest.mockReset();
  enqueueSupplyRequest.mockImplementation(async () => ({ id: 1, queuedInTransaction: prisma.inTransaction === true }));
  mockCurrentUser = { id: 1, role: "STUDENT" };
}

module.exports = { createApp, prisma, searchPlaces, describeLocation, enqueueSupplyRequest, setUser, resetMocks };
