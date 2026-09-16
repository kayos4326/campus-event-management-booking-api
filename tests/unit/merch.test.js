jest.mock("axios");
jest.mock("../../src/services/prisma", () => ({
  prisma: { merchPreorder: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() } },
}));

const axios = require("axios");
const { prisma } = require("../../src/services/prisma");
const { createSupplyRequest, sendSupplyRequest } = require("../../src/services/merch");

const event = { id: 7, title: "Tech Conference", capacity: 300 };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DISCORD_WEBHOOK_URL = "https://discord.test/webhook";
});

// Until 2026-09-16 this always ordered 50 lanyards; organizers now choose both.
describe("createSupplyRequest", () => {
  test("records what was asked for, as PENDING — nothing is ordered yet", async () => {
    prisma.merchPreorder.create.mockResolvedValue({ id: 1 });

    await createSupplyRequest(7, { item: "Water bottles", quantity: 120 });

    expect(prisma.merchPreorder.create).toHaveBeenCalledWith({
      data: { eventId: 7, item: "Water bottles", quantity: 120, status: "PENDING" },
    });
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe("sendSupplyRequest", () => {
  test("posts the item and amount to Discord and stores the message id", async () => {
    prisma.merchPreorder.findUnique.mockResolvedValue({ id: 1, item: "Water bottles", quantity: 120, status: "PENDING" });
    axios.post.mockResolvedValue({ data: { id: "1549433934344093887" } });

    await sendSupplyRequest(event);

    const [url, body] = axios.post.mock.calls[0];
    expect(url).toBe("https://discord.test/webhook?wait=true"); // ?wait=true returns the message
    expect(body.content).toContain("120 × Water bottles");
    expect(body.content).toContain("Tech Conference");
    expect(prisma.merchPreorder.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: "CONFIRMED", peerOrderRef: "1549433934344093887" },
    });
  });

  test("marks it FAILED when Discord is unreachable, without throwing", async () => {
    prisma.merchPreorder.findUnique.mockResolvedValue({ id: 1, item: "T-shirts", quantity: 10, status: "PENDING" });
    axios.post.mockRejectedValue(new Error("network down"));

    await expect(sendSupplyRequest(event)).resolves.toBeUndefined();

    expect(prisma.merchPreorder.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { status: "FAILED" } });
  });

  // Publishing, unpublishing and publishing again must not order the supplies twice.
  test("does nothing when the order was already sent", async () => {
    prisma.merchPreorder.findUnique.mockResolvedValue({ id: 1, status: "CONFIRMED" });

    await sendSupplyRequest(event);

    expect(axios.post).not.toHaveBeenCalled();
  });

  test("retries a previously failed order", async () => {
    prisma.merchPreorder.findUnique.mockResolvedValue({ id: 1, item: "Lanyards", quantity: 50, status: "FAILED" });
    axios.post.mockResolvedValue({ data: { id: "99" } });

    await sendSupplyRequest(event);

    expect(axios.post).toHaveBeenCalled();
  });

  test("does nothing when the event has no supply order", async () => {
    prisma.merchPreorder.findUnique.mockResolvedValue(null);

    await sendSupplyRequest(event);

    expect(axios.post).not.toHaveBeenCalled();
  });
});
