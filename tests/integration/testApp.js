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
    venue: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
    event: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    booking: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    user: { findMany: jest.fn(), upsert: jest.fn(), update: jest.fn() },
    apiKey: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    merchPreorder: { create: jest.fn(), update: jest.fn() },
    // Interactive transactions just run the callback against this same mock client.
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

jest.mock("../../src/services/merch", () => ({
  preorderLanyards: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../src/services/geoapify", () => ({
  geocodeAddress: jest.fn(),
}));

const { createApp } = require("../../src/app");
const { prisma } = require("../../src/services/prisma");
const { geocodeAddress } = require("../../src/services/geoapify");
const { preorderLanyards } = require("../../src/services/merch");

function setUser(user) {
  mockCurrentUser = user;
}

function resetMocks() {
  Object.entries(prisma).forEach(([key, model]) => {
    if (key.startsWith("$")) return model.mockReset();
    Object.values(model).forEach((fn) => fn.mockReset());
  });
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
  prisma.$queryRaw.mockResolvedValue([]);
  // Seat-bookkeeping defaults: no confirmed seats and nobody waitlisted, unless a test says so.
  prisma.booking.count.mockResolvedValue(0);
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.booking.updateMany.mockResolvedValue({ count: 0 });
  geocodeAddress.mockReset();
  preorderLanyards.mockClear();
  mockCurrentUser = { id: 1, role: "STUDENT" };
}

module.exports = { createApp, prisma, geocodeAddress, preorderLanyards, setUser, resetMocks };
