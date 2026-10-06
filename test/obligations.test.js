const { describe, test, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

/*
 * Deadlines: generation from the bundle's rules, states worked out on read,
 * the reminder runner and the routes — against an in-memory stand-in for
 * the database (COMP-01–07, FIX-08, FIX-15, FIX-20).
 */

process.env.JWT_SECRET = "unit-test-secret";
process.env.JWT_ISSUER = "unit-test-issuer";
process.env.BUNDLE_SERVICE_URL = "http://bundle-service.test";
process.env.EMAIL_SERVICE_URL = "http://email-service.test";

const RULES = [
  { id: 1, key: "gstr1", name: "GSTR-1", service_key: "gst_returns", revision: 1, definition: { kind: "periodic", frequency: "monthly", schedule: { day: 11, offsetMonths: 1 } } },
  { id: 2, key: "itr", name: "Income tax return", service_key: "itr", revision: 1, definition: { kind: "periodic", frequency: "yearly", condition: { engaged: "tax_audit" }, schedule: { date: "10-31" }, else: { date: "07-31" } } },
  { id: 3, key: "tds_return", name: "TDS return", service_key: "tds", revision: 1, definition: { kind: "periodic", frequency: "quarterly", schedule: { dates: { Q1: "07-31", Q2: "10-31", Q3: "01-31", Q4: "05-31" } } } },
];

let statements;
let state;
let installed;
let triggered;

const realFetch = global.fetch;

global.fetch = async (url, options) => {
  if (String(url).startsWith("http://bundle-service.test")) return new Response(JSON.stringify({ bundle: installed }), { status: 200 });
  if (String(url).startsWith("http://email-service.test")) {
    triggered.push({ auth: options.headers.Authorization, body: JSON.parse(options.body) });
    return new Response("{}", { status: 202 });
  }
  return realFetch(url, options);
};

function query(text, params = []) {
  const sql = text.replace(/\s+/g, " ").trim();
  statements.push({ sql, params });

  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || /access_grants/.test(sql)) return { rows: [] };
  if (/^SELECT time_zone FROM organizations/.test(sql)) return { rows: [{ time_zone: "Asia/Kolkata" }] };
  if (/FROM engagements e JOIN engagement_types t/.test(sql)) return { rows: [state.engagement] };
  if (/FROM engagement_lines l JOIN services s/.test(sql)) return { rows: state.engaged.map((key, index) => ({ id: 10 + index, key })) };
  if (/^SELECT \* FROM obligation_rules WHERE organization_id = \$1 AND is_active/.test(sql)) return { rows: RULES.filter((rule) => params[1].includes(rule.service_key)) };
  if (/^SELECT rule_id, period_key, due_on FROM obligation_overrides/.test(sql)) return { rows: state.overrides };
  if (/^INSERT INTO obligations/.test(sql)) return { rowCount: 1 };
  if (/^DELETE FROM obligations/.test(sql)) return { rowCount: 2 };
  if (/^SELECT o\.id, o\.customer_id, c\.name AS customer_name/.test(sql)) return { rows: state.feed };
  if (/FROM organizations o JOIN organization_bundles/.test(sql)) return { rows: [{ id: 3, time_zone: "Asia/Kolkata" }] };
  if (/^SELECT o\.id, o\.title, o\.due_on::text AS due_on/.test(sql)) return { rows: state.due };
  return { rows: [], rowCount: 1 };
}

const pool = require("../src/config/database");

pool.query = async (text, params) => query(text, params);
pool.connect = async () => ({ query: async (text, params) => query(text, params), release() {} });

const obligations = require("../src/services/obligationService");
const reminders = require("../src/workers/reminderRunner");
const { forget } = require("../src/services/bundleContext");

beforeEach(() => {
  statements = [];
  triggered = [];
  installed = { key: "ca-practice" };
  forget(3);
  delete process.env.SERVICE_JWT_SECRET;
  state = {
    engagement: { id: 7, customer_id: 5, period_label: "2025-26", attributes: {}, status: "active", period_kind: "financial_year", period_start_month: 4, client_attributes: {}, archived_at: null },
    engaged: ["gst_returns", "itr"],
    overrides: [],
    feed: [],
    due: [],
  };
});

after(() => {
  global.fetch = realFetch;
});

const inserts = () => statements.filter((s) => /^INSERT INTO obligations/.test(s.sql));

describe("generation (COMP-01)", () => {
  test("only engaged services generate deadlines — no TDS for a client not engaged for it (FIX-15)", async () => {
    const result = await obligations.generateForEngagement(3, 7);

    assert.equal(result.generated, 13); // 12 × GSTR-1 + 1 ITR
    assert.equal(inserts().some((s) => s.params[4] === "tds_return"), false);
    assert.equal(inserts()[0].params[10], "2025-05-11"); // April's GSTR-1, on the 11th, not the 10th (FIX-08)
  });

  test("a rule's condition reads what is engaged: ITR moves to 31 Oct with a tax audit", async () => {
    await obligations.generateForEngagement(3, 7);
    assert.equal(inserts().find((s) => s.params[4] === "itr").params[10], "2026-07-31");

    statements = [];
    state.engaged = ["itr", "tax_audit"];
    await obligations.generateForEngagement(3, 7);
    assert.equal(inserts().find((s) => s.params[4] === "itr").params[10], "2026-10-31");
  });

  test("an extension replaces the computed date for its period (FIX-20)", async () => {
    state.overrides = [{ rule_id: 2, period_key: "2025-26", due_on: "2026-11-15" }];

    await obligations.generateForEngagement(3, 7);

    assert.equal(inserts().find((s) => s.params[4] === "itr").params[10], "2026-11-15");
  });

  test("never rewrites a deadline already filed, and drops only pending ones no longer engaged", async () => {
    await obligations.generateForEngagement(3, 7);

    assert.match(inserts()[0].sql, /WHERE obligations\.status IN \('pending', 'in_progress'\)/);
    assert.match(statements.find((s) => /^DELETE FROM obligations/.test(s.sql)).sql, /status = 'pending'/);
  });

  test("a cancelled engagement keeps nothing pending", async () => {
    state.engagement.status = "cancelled";

    const result = await obligations.generateForEngagement(3, 7);

    assert.equal(result.generated, 0);
    assert.equal(result.dropped, 2);
  });
});

describe("states (COMP-02)", () => {
  const today = "2026-10-05";
  const soon = "2026-11-04";
  const at = (due, status = "pending") => obligations.stateOf({ due_on: due, status }, today, soon);

  test("filed and N/A are completed; in progress stays in progress", () => {
    assert.equal(at("2026-01-01", "filed"), "completed");
    assert.equal(at("2026-01-01", "not_applicable"), "completed");
    assert.equal(at("2026-01-01", "in_progress"), "in_progress");
  });

  test("past due is overdue; within 30 days is due soon; later is upcoming", () => {
    assert.equal(at("2026-10-04"), "overdue");
    assert.equal(at("2026-10-05"), "due_soon");
    assert.equal(at("2026-11-04"), "due_soon");
    assert.equal(at("2026-11-05"), "upcoming");
  });

  test("the feed sorts overdue → due soon → in progress → upcoming → completed (COMP-05) and counts each", async () => {
    state.feed = [
      { id: 1, due_on: "2099-01-01", status: "pending" },
      { id: 2, due_on: "2000-01-01", status: "filed" },
      { id: 3, due_on: "2000-01-02", status: "pending" },
      { id: 4, due_on: "2099-01-01", status: "in_progress" },
    ];

    const { items, counts } = await obligations.feed(3, {});

    assert.deepEqual(items.map((item) => item.state), ["overdue", "in_progress", "upcoming", "completed"]);
    assert.deepEqual(counts, { overdue: 1, due_soon: 0, in_progress: 1, upcoming: 1, completed: 1 });
  });
});

describe("reminders", () => {
  test("stay off without SERVICE_JWT_SECRET", async () => {
    assert.match((await reminders.runOnce()).skipped, /SERVICE_JWT_SECRET/);
  });

  test("raise due-soon and overdue once each, signed as the service for one organization", async () => {
    process.env.SERVICE_JWT_SECRET = "unit-test-service-secret";
    state.due = [
      { id: 41, title: "GSTR-1 · Sep 2026", due_on: "2099-01-01", period_label: "2026-27", customer_id: 5, customer_name: "Acme", customer_email: "a@acme.example" },
      { id: 42, title: "TDS return · Q1 2026-27", due_on: "2000-01-01", period_label: "2026-27", customer_id: 5, customer_name: "Acme", customer_email: "a@acme.example" },
    ];

    const { raised } = await reminders.runOnce();

    assert.equal(raised, 2);
    assert.deepEqual(triggered.map((call) => [call.body.event, call.body.dedupe_key]), [
      ["obligation.due_soon", "obligation:41:due_soon"],
      ["obligation.overdue", "obligation:42:overdue"],
    ]);

    const claims = jwt.verify(triggered[0].auth.split(" ")[1], "unit-test-service-secret", { issuer: "omnicore-services" });

    assert.deepEqual([claims.organizationId, claims.scope], [3, "automations.trigger"]);
    assert.equal(triggered[0].body.payload.client.email, "a@acme.example");
    assert.equal(triggered[0].body.payload.obligation.due_on, "1 January 2099");
  });
});

describe("routes", () => {
  const app = require("../src/app");
  let server;
  let base;

  before(async () => {
    mock.method(console, "log", () => {});
    mock.method(console, "error", () => {});
    mock.method(console, "warn", () => {});
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  const call = (method, path, permissions, body) =>
    realFetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt.sign({ sub: 1, organizationId: 3, role: "X", permissions }, process.env.JWT_SECRET, { issuer: process.env.JWT_ISSUER })}` },
      body: body && JSON.stringify(body),
    });

  test("answer 'not enabled' without a bundle — except the install step", async () => {
    installed = null;
    assert.equal((await call("GET", "/obligations", ["obligations.read"])).status, 404);
    assert.equal((await call("PUT", "/obligations/bundles/ca-practice/0.4.0", ["bundles.manage"], { obligations: [] })).status, 200);
  });

  test("generation follows engagement edits: engagements.update or obligations.update", async () => {
    assert.equal((await call("POST", "/obligations/generate", ["engagements.read"], { engagementId: 7 })).status, 403);
    assert.equal((await call("POST", "/obligations/generate", ["engagements.update"], { engagementId: 7 })).status, 200);
  });

  test("rules and extensions need obligations.rules", async () => {
    assert.equal((await call("PUT", "/obligations/rules/itr/overrides/2025-26", ["obligations.update"], { dueOn: "2026-11-15" })).status, 403);
    assert.equal((await call("POST", "/obligations/reminders/run", ["obligations.update"])).status, 403);
  });
});
