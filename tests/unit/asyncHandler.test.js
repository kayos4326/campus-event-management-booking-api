const { asyncHandler } = require("../../src/middleware/asyncHandler");

// Regression test for a real bug (CLAUDE.md §4): Express 4 doesn't forward a rejected
// promise from an async handler to error middleware — an unwrapped handler just hangs
// the request forever instead of returning an error. This confirms the wrapper actually
// prevents that by always calling next() with the error.
describe("asyncHandler", () => {
  test("forwards a rejected promise to next() instead of hanging", async () => {
    const err = new Error("boom");
    const handler = asyncHandler(async () => {
      throw err;
    });
    const next = jest.fn();

    await handler({}, {}, next);

    expect(next).toHaveBeenCalledWith(err);
  });

  test("does not call next() when the handler resolves normally", async () => {
    const handler = asyncHandler(async (req, res) => {
      res.send();
    });
    const res = { send: jest.fn() };
    const next = jest.fn();

    await handler({}, res, next);

    expect(res.send).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test("passes req/res/next through to the wrapped handler", async () => {
    const handler = asyncHandler(async (req, res, next) => {
      res.json({ id: req.params.id });
    });
    const res = { json: jest.fn() };

    await handler({ params: { id: 42 } }, res, jest.fn());

    expect(res.json).toHaveBeenCalledWith({ id: 42 });
  });
});
