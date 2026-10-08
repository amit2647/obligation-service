const { describe, test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

/*
 * A firm's own deadlines, and its edits to the bundle's, from the service
 * screen: checked by bundle-sdk against the organization's services, keyed
 * uniquely, and never deleting a bundle rule.
 */

const pool = require("../src/config/database");
const ruleService = require("../src/services/ruleService");

let statements;
let rules;

pool.query = async (text, params = []) => {
  const sql = text.replace(/\s+/g, " ").trim();
  statements.push({ sql, params });

  if (/^SELECT key FROM services/.test(sql)) return { rows: ["gst_returns", "tax_audit", "itr", "payroll_review"].map((key) => ({ key })) };
  if (/^SELECT period_kind, period_start_month FROM engagement_types/.test(sql)) return { rows: [{ period_kind: "financial_year", period_start_month: 4 }] };
  if (/^SELECT key FROM obligation_rules/.test(sql)) return { rows: rules.map((rule) => ({ key: rule.key })) };
  if (/^SELECT \* FROM obligation_rules WHERE organization_id = \$1 AND key = \$2/.test(sql)) return { rows: rules.filter((rule) => rule.key === params[1]) };
  if (/^INSERT INTO obligation_rules/.test(sql)) {
    rules.push({ id: 9, key: params[1], service_key: params[2], name: params[3], frequency: params[4], definition: params[5], revision: 1, bundle_key: null });
    return { rowCount: 1 };
  }
  if (/^UPDATE obligation_rules SET name/.test(sql)) {
    const rule = rules.find((item) => item.id === params[3]);
    Object.assign(rule, { name: params[0], frequency: params[1], definition: params[2] });
    return { rowCount: 1 };
  }
  return { rows: [], rowCount: 1 };
};

beforeEach(() => {
  statements = [];
  rules = [{ id: 1, key: "gstr1", service_key: "gst_returns", name: "GSTR-1", revision: 1, bundle_key: "ca-practice", frequency: "monthly", definition: { kind: "periodic", frequency: "monthly", schedule: { day: 11, offsetMonths: 1 } } }];
});

describe("a firm's deadline rules", () => {
  test("a new rule for the firm's own service is checked, keyed and stored as the firm's", async () => {
    const created = await ruleService.createRule(3, { serviceKey: "payroll_review", name: "Payroll review", frequency: "quarterly", schedule: { dates: { Q1: "07-15", Q2: "10-15", Q3: "01-15", Q4: "04-15" } } });

    assert.equal(created.key, "payroll_review");
    assert.equal(created.bundle_key, null);
    assert.deepEqual(created.definition, { kind: "periodic", frequency: "quarterly", schedule: { dates: { Q1: "07-15", Q2: "10-15", Q3: "01-15", Q4: "04-15" } } });
  });

  test("a taken key is numbered", async () => {
    const created = await ruleService.createRule(3, { serviceKey: "gst_returns", name: "GSTR 1", frequency: "monthly", schedule: { day: 13, offsetMonths: 1 } });
    assert.equal(created.key, "gstr_1");
    const again = await ruleService.createRule(3, { serviceKey: "gst_returns", name: "GSTR 1", frequency: "monthly", schedule: { day: 14, offsetMonths: 1 } });
    assert.equal(again.key, "gstr_1_2");
  });

  test("a rule bundle-sdk refuses is not saved, with its reason", async () => {
    await assert.rejects(
      ruleService.createRule(3, { serviceKey: "unknown", name: "X", frequency: "yearly", schedule: { date: "09-30" } }),
      (error) => error.statusCode === 400 && /not in the catalog/.test(error.message),
    );
    await assert.rejects(
      ruleService.createRule(3, { serviceKey: "itr", name: "ITR", frequency: "yearly", schedule: { date: "07-31" }, condition: { engaged: "nope" }, else: { date: "10-31" } }),
      (error) => error.statusCode === 400,
    );
    assert.ok(!statements.some((statement) => /^INSERT INTO obligation_rules/.test(statement.sql)));
  });

  test("editing a bundle rule changes its timing, keeps its service, and keeps it the bundle's", async () => {
    const updated = await ruleService.updateRule(3, "gstr1", { name: "GSTR-1 (monthly)", frequency: "monthly", schedule: { day: 13, offsetMonths: 1 }, serviceKey: "tax_audit" });

    assert.equal(updated.name, "GSTR-1 (monthly)");
    assert.equal(updated.service_key, "gst_returns");
    assert.deepEqual(updated.definition.schedule, { day: 13, offsetMonths: 1 });
    assert.equal(updated.bundle_key, "ca-practice");
  });

  test("a bundle rule is switched off, never removed; the firm's own can go", async () => {
    await assert.rejects(ruleService.removeRule(3, "gstr1"), (error) => error.statusCode === 409);

    rules.push({ id: 5, key: "own", service_key: "payroll_review", bundle_key: null });
    await ruleService.removeRule(3, "own");
    assert.ok(statements.some((statement) => /^UPDATE obligation_rules SET retired_at = NOW\(\)/.test(statement.sql) && statement.params[0] === 5));
  });
});
