const { test, before, after, mock } = require("node:test");
const assert = require("node:assert/strict");

/*
 * /health is what compose's healthcheck and Kong's dependants wait on, so it
 * must report the database honestly: ok only when a query succeeds.
 */

let failing = false;

const pool = require("../src/config/database");

pool.query = async () => {
  if (failing) {
    throw new Error("connection refused");
  }

  return { rows: [{ "?column?": 1 }] };
};

const app = require("../src/app");

let server;
let base;

before(async () => {
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});

  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("GET /health is ok when the database answers", async () => {
  failing = false;

  const response = await fetch(`${base}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { service: "obligation-service", status: "ok", database: "postgresql" });
});

test("GET /health is 503 when the database does not", async () => {
  failing = true;

  const response = await fetch(`${base}/health`);

  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, "error");
});

test("unknown routes are 404, not a crash", async () => {
  const response = await fetch(`${base}/nothing-here`);

  assert.equal(response.status, 404);
});
