const { describe, test, before, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

/*
 * The request pipeline every route in this service goes through:
 * authenticate (Hydra's JWT + live access grants) and requirePermission.
 *
 * Each service keeps its own copy of these files, so each tests its own copy.
 * Assertions are on status codes and whether next() ran, not on error bodies,
 * which differ between copies without differing in meaning.
 */

// Hydra's tokens, signed with a test key served as a stubbed JWKS.
const hydra = require("./helpers/hydraToken");

before(() => hydra.ready);

// The grant lookup is the only database call on this path. It is replaced
// before the middleware loads, so no test needs a database.
let grantRows = [];
let grantError = null;

async function fakeQuery() {
  if (grantError) {
    throw grantError;
  }

  return { rows: grantRows };
}

const pool = require("../src/config/database");

pool.query = fakeQuery;

const { mergeAccessGrants } = require("../src/middleware/accessGrants");
const authenticate = require("../src/middleware/authenticate");
const requirePermission = require("../src/middleware/requirePermission");

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function run(middleware, req) {
  const res = fakeResponse();
  let nextCalled = false;

  await middleware(req, res, () => {
    nextCalled = true;
  });

  return { res, nextCalled };
}

function sign(overrides = {}, options = {}) {
  return hydra.sign(
    {
      sub: 7,
      organizationId: 3,
      role: "SALES_REP",
      permissions: ["leads.read"],
      ...overrides,
    },
    options,
  );
}

function withBearer(token) {
  return { headers: { authorization: `Bearer ${token}` } };
}

beforeEach(() => {
  grantRows = [];
  grantError = null;
  // Failure paths log by design; keep the test output readable.
  mock.method(console, "error", () => {});
});

describe("requirePermission", () => {
  test("lets a caller holding the permission through", async () => {
    const { nextCalled } = await run(requirePermission("leads.read"), {
      auth: { permissions: ["leads.read"] },
    });

    assert.equal(nextCalled, true);
  });

  test("refuses a caller without it with 403", async () => {
    const { res, nextCalled } = await run(requirePermission("leads.delete"), {
      auth: { permissions: ["leads.read"] },
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });

  test("never lets an unauthenticated request through", async () => {
    let outcome;

    try {
      outcome = await run(requirePermission("leads.read"), {});
    } catch {
      // A copy that assumes req.auth exists throws here; that still denies.
      outcome = { nextCalled: false, res: { statusCode: 401 } };
    }

    assert.equal(outcome.nextCalled, false);
    assert.ok([401, 403].includes(outcome.res.statusCode));
  });
});

describe("authenticate", () => {
  test("accepts a valid token and exposes the caller", async () => {
    const req = withBearer(sign());

    const { nextCalled } = await run(authenticate, req);

    assert.equal(nextCalled, true);
    assert.equal(req.auth.userId, 7);
    assert.equal(req.auth.organizationId, 3);
    assert.deepEqual(req.auth.permissions, ["leads.read"]);
  });

  test("rejects a request with no Authorization header", async () => {
    const { res, nextCalled } = await run(authenticate, { headers: {} });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  test("rejects a non-Bearer scheme", async () => {
    const { res, nextCalled } = await run(authenticate, {
      headers: { authorization: `Basic ${sign()}` },
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  test("rejects a token signed with another key", async () => {
    const other = require("crypto").generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const { res, nextCalled } = await run(authenticate, withBearer(sign({}, { key: other })));

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  test("rejects a token from another issuer", async () => {
    const { res, nextCalled } = await run(
      authenticate,
      withBearer(sign({}, { issuer: "http://someone-else/" })),
    );

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  test("rejects an expired token", async () => {
    const expired = sign({ permissions: [], exp: Math.floor(Date.now() / 1000) - 60 }, { expiresIn: null });

    const { res, nextCalled } = await run(authenticate, withBearer(expired));

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  test("refuses an HS256 token signed with the old shared secret", async () => {
    const legacy = jwt.sign(
      { sub: 7, organizationId: 3, role: "SUPER_ADMIN", permissions: ["leads.read"] },
      "omnicore-development-secret-change-this",
      { issuer: "omnicore-identity-service", expiresIn: "5m" },
    );

    const { res, nextCalled } = await run(authenticate, withBearer(legacy));

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  test("fails closed when HYDRA_JWKS_URL is unset", async () => {
    const token = sign();
    const saved = process.env.HYDRA_JWKS_URL;

    delete process.env.HYDRA_JWKS_URL;

    try {
      const { res, nextCalled } = await run(authenticate, withBearer(token));

      // Some copies answer 500 (a configuration error), others 401. Either
      // way the request must not get through.
      assert.equal(nextCalled, false);
      assert.ok(res.statusCode >= 400);
    } finally {
      process.env.HYDRA_JWKS_URL = saved;
    }
  });

  test("adds live access grants to the token's permissions", async () => {
    grantRows = [{ permission_code: "customers.read" }];

    const req = withBearer(sign());

    await run(authenticate, req);

    assert.deepEqual([...req.auth.permissions].sort(), ["customers.read", "leads.read"]);
  });
});

describe("mergeAccessGrants", () => {
  test("adds granted permissions without duplicating held ones", async () => {
    grantRows = [{ permission_code: "leads.read" }, { permission_code: "services.read" }];

    const auth = await mergeAccessGrants({
      userId: 1,
      organizationId: 1,
      permissions: ["leads.read"],
    });

    assert.deepEqual([...auth.permissions].sort(), ["leads.read", "services.read"]);
  });

  test("keeps the token's permissions when the lookup fails", async () => {
    grantError = new Error("database down");

    const auth = await mergeAccessGrants({
      userId: 1,
      organizationId: 1,
      permissions: ["leads.read"],
    });

    assert.deepEqual(auth.permissions, ["leads.read"]);
  });

  test("leaves a caller with no user id untouched", async () => {
    grantRows = [{ permission_code: "leads.delete" }];

    const auth = await mergeAccessGrants({ permissions: ["leads.read"] });

    assert.deepEqual(auth.permissions, ["leads.read"]);
  });
});
