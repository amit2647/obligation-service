const pool = require("../config/database");
const { customized, decide, optionsFor } = require("./bundleSync");

/*
 * Deadline rules, installed from the organization's bundle and matched by
 * key. The rule as shipped is kept whole in `definition` and evaluated by
 * bundle-sdk's schedules — the code bundle-lint dry-runs — so a rule that
 * lints is a rule that generates. A firm's edits survive upgrades
 * (bundleSync); rules a bundle drops are retired, never deleted.
 */

function httpError(statusCode, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

const DEFINITION_KEYS = ["kind", "frequency", "schedule", "condition", "else", "relativeTo", "offsetDays"];

function definitionOf(rule) {
  return Object.fromEntries(DEFINITION_KEYS.filter((key) => rule[key] !== undefined).map((key) => [key, rule[key]]));
}

const content = (row) => ({
  name: row.name,
  service_key: row.service_key ?? row.service,
  is_active: row.is_active ?? true,
  definition: row.definition ?? definitionOf(row),
});

async function installRules(organizationId, bundleKey, version, rules = [], choices = {}) {
  for (const rule of rules) {
    if (!rule?.key || !rule.service || !rule.name || !["periodic", "relative", "manual"].includes(rule.kind)) {
      throw httpError(400, "Each rule needs a key, a service, a name and a kind");
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const summary = { inserted: 0, updated: 0, unchanged: 0, kept: 0, retired: 0, customized: [] };

    for (const rule of rules) {
      const shipped = content(rule);
      const found = await client.query("SELECT * FROM obligation_rules WHERE organization_id = $1 AND key = $2", [organizationId, rule.key]);
      const row = found.rows[0];
      const { action, shippedChecksum, flag, acknowledge } = decide(row && { content: content(row), sourceChecksum: row.source_checksum }, shipped, optionsFor(choices, "rule", rule.key));

      if (action === "insert") {
        await client.query(
          `INSERT INTO obligation_rules (organization_id, bundle_key, key, service_key, name, kind, frequency, definition, revision,
                                         source_version, source_checksum)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [organizationId, bundleKey, rule.key, shipped.service_key, shipped.name, rule.kind, rule.frequency || null,
            shipped.definition, rule.revision || 1, version, shippedChecksum],
        );
        summary.inserted += 1;
        continue;
      }

      if (action === "keep") {
        await client.query(
          `UPDATE obligation_rules SET bundle_key = $1, retired_at = NULL,
             update_available_version = CASE WHEN $5 THEN NULL WHEN $2 THEN $3 ELSE update_available_version END,
             source_checksum = CASE WHEN $5 THEN $6 ELSE source_checksum END
           WHERE id = $4`,
          [bundleKey, flag, version, row.id, Boolean(acknowledge), shippedChecksum],
        );
        summary.kept += 1;
        if (flag) summary.customized.push(customized("rule", rule.key, row.name, content(row), shipped, version));
        continue;
      }

      if (action === "update") {
        await client.query(
          `UPDATE obligation_rules SET name = $1, service_key = $2, kind = $3, frequency = $4, definition = $5, revision = $6, updated_at = NOW()
           WHERE id = $7`,
          [shipped.name, shipped.service_key, rule.kind, rule.frequency || null, shipped.definition, rule.revision || 1, row.id],
        );
      }

      await client.query(
        `UPDATE obligation_rules SET bundle_key = $1, source_version = $2, source_checksum = $3,
           update_available_version = NULL, retired_at = NULL
         WHERE id = $4`,
        [bundleKey, version, shippedChecksum, row.id],
      );
      summary[action === "update" ? "updated" : "unchanged"] += 1;
    }

    const retired = await client.query(
      `UPDATE obligation_rules SET retired_at = NOW()
       WHERE organization_id = $1 AND bundle_key = $2 AND retired_at IS NULL AND key <> ALL($3::text[])`,
      [organizationId, bundleKey, rules.map((rule) => rule.key)],
    );
    summary.retired = retired.rowCount;

    // A dry run does all the work and rolls it back, to report what it would do.
    await client.query(choices.dryRun ? "ROLLBACK" : "COMMIT");
    return summary;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function listRules(organizationId) {
  const rules = await pool.query(
    `SELECT id, key, service_key, name, kind, frequency, definition, revision, is_active, update_available_version
     FROM obligation_rules WHERE organization_id = $1 AND retired_at IS NULL ORDER BY service_key, name`,
    [organizationId],
  );
  const overrides = await pool.query(
    `SELECT o.rule_id, o.period_key, o.due_on, o.reason FROM obligation_overrides o
     WHERE o.organization_id = $1 ORDER BY o.period_key`,
    [organizationId],
  );

  return rules.rows.map((rule) => ({ ...rule, overrides: overrides.rows.filter((item) => item.rule_id === rule.id) }));
}

async function getRule(organizationId, key) {
  const result = await pool.query("SELECT * FROM obligation_rules WHERE organization_id = $1 AND key = $2 AND retired_at IS NULL", [organizationId, key]);

  if (!result.rows[0]) throw httpError(404, "No such rule");

  return result.rows[0];
}

// Switching a rule off stops it generating; deadlines already made stay.
async function setActive(organizationId, key, isActive) {
  const rule = await getRule(organizationId, key);

  await pool.query("UPDATE obligation_rules SET is_active = $1, updated_at = NOW() WHERE id = $2", [Boolean(isActive), rule.id]);
}

async function setOverride({ organizationId, userId }, key, periodKey, dueOn, reason) {
  const rule = await getRule(organizationId, key);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn || "")) throw httpError(400, "Enter the extended due date", { dueOn: "Use YYYY-MM-DD" });
  if (!periodKey || String(periodKey).length > 30) throw httpError(400, "Name the period", { periodKey: "e.g. 2025-26 or 2025-26:Q2" });

  await pool.query(
    `INSERT INTO obligation_overrides (organization_id, rule_id, period_key, due_on, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (rule_id, period_key) DO UPDATE SET due_on = EXCLUDED.due_on, reason = EXCLUDED.reason, created_by = EXCLUDED.created_by`,
    [organizationId, rule.id, periodKey, dueOn, reason || null, userId],
  );

  // Open deadlines move with the extension; filed ones never change.
  const moved = await pool.query(
    `UPDATE obligations SET due_on = $1, updated_at = NOW()
     WHERE rule_id = $2 AND period_key = $3 AND status IN ('pending', 'in_progress')`,
    [dueOn, rule.id, periodKey],
  );

  return { moved: moved.rowCount };
}

async function removeOverride(organizationId, key, periodKey) {
  const rule = await getRule(organizationId, key);
  await pool.query("DELETE FROM obligation_overrides WHERE rule_id = $1 AND period_key = $2", [rule.id, periodKey]);
}

module.exports = { installRules, listRules, getRule, setActive, setOverride, removeOverride, definitionOf };
