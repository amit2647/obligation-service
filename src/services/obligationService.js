const { schedules } = require("bundle-sdk");

const pool = require("../config/database");

/*
 * Compliance deadlines (COMP-01–07, CD-07).
 *
 * Generated, not typed in: for each engagement, every active rule whose
 * service is engaged that period runs through bundle-sdk's schedules with the
 * client and engagement as its data, an extension (override) for that period
 * replacing the computed date. Generation is idempotent (one deadline per
 * client, rule and period), never touches a deadline already filed, and drops
 * pending ones whose service is no longer engaged.
 *
 * Overdue, due soon and upcoming are worked out on read against today in the
 * organization's time zone (COMP-02, FIX-08).
 */

const DUE_SOON_DAYS = 30;

// Sort order of the feed (COMP-05).
const STATE_ORDER = ["overdue", "due_soon", "in_progress", "upcoming", "completed"];

function httpError(statusCode, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

async function todayFor(organizationId) {
  const result = await pool.query("SELECT time_zone FROM organizations WHERE id = $1", [organizationId]);
  return schedules.todayIn(result.rows[0]?.time_zone || "UTC");
}

function stateOf(item, today, soon) {
  if (item.status === "filed" || item.status === "not_applicable") return "completed";
  if (item.status === "in_progress") return "in_progress";

  const due = typeof item.due_on === "string" ? item.due_on.slice(0, 10) : item.due_on.toISOString().slice(0, 10);

  if (due < today) return "overdue";
  if (due <= soon) return "due_soon";
  return "upcoming";
}

const isoDate = (value) => (typeof value === "string" ? value.slice(0, 10) : value ? value.toISOString().slice(0, 10) : null);

/*
 * (Re)generates the deadlines of one engagement. Returns what changed.
 */
async function generateForEngagement(organizationId, engagementId) {
  const loaded = await pool.query(
    `SELECT e.id, e.customer_id, e.period_label, e.attributes, e.appointment_on, e.status,
            t.period_kind, t.period_start_month,
            c.attributes AS client_attributes, c.archived_at
     FROM engagements e
     JOIN engagement_types t ON t.id = e.engagement_type_id
     JOIN customers c ON c.id = e.customer_id
     WHERE e.id = $1 AND e.organization_id = $2`,
    [engagementId, organizationId],
  );
  const engagement = loaded.rows[0];

  if (!engagement) throw httpError(404, "Engagement not found");

  const lines = await pool.query(
    `SELECT s.id, s.key FROM engagement_lines l JOIN services s ON s.id = l.service_id
     WHERE l.engagement_id = $1 AND s.key IS NOT NULL`,
    [engagementId],
  );
  const engaged = lines.rows.map((row) => row.key);
  const serviceIdByKey = new Map(lines.rows.map((row) => [row.key, row.id]));

  const live = engagement.status !== "cancelled" && !engagement.archived_at && engagement.period_label && engagement.period_kind !== "none";

  const rules = live
    ? (await pool.query(
        "SELECT * FROM obligation_rules WHERE organization_id = $1 AND is_active AND retired_at IS NULL AND service_key = ANY($2::text[])",
        [organizationId, engaged],
      )).rows
    : [];

  const overrides = await pool.query(
    "SELECT rule_id, period_key, due_on FROM obligation_overrides WHERE organization_id = $1",
    [organizationId],
  );
  const overrideOf = new Map(overrides.rows.map((row) => [`${row.rule_id}|${row.period_key}`, isoDate(row.due_on)]));

  const items = [];

  if (live) {
    const period = schedules.periodFromLabel(engagement.period_label, { periodKind: engagement.period_kind, periodStartMonth: engagement.period_start_month });
    const data = {
      client: { attributes: engagement.client_attributes || {} },
      engagement: { attributes: engagement.attributes || {}, appointment_on: isoDate(engagement.appointment_on), period_label: engagement.period_label },
      engaged,
    };

    for (const rule of rules) {
      for (const item of schedules.generate({ key: rule.key, name: rule.name, ...rule.definition }, period, data)) {
        items.push({
          rule,
          periodKey: item.periodKey,
          title: item.title,
          dueOn: overrideOf.get(`${rule.id}|${item.periodKey}`) || item.dueOn,
          serviceId: serviceIdByKey.get(rule.service_key) || null,
        });
      }
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let written = 0;

    for (const item of items) {
      const result = await client.query(
        `INSERT INTO obligations (organization_id, customer_id, engagement_id, rule_id, rule_key, rule_version, service_id,
                                  title, period_label, period_key, due_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (customer_id, rule_id, period_key) WHERE rule_id IS NOT NULL
         DO UPDATE SET due_on = EXCLUDED.due_on, title = EXCLUDED.title, engagement_id = EXCLUDED.engagement_id,
                       rule_version = EXCLUDED.rule_version, service_id = EXCLUDED.service_id, updated_at = NOW()
         WHERE obligations.status IN ('pending', 'in_progress')
           AND (obligations.due_on, obligations.title) IS DISTINCT FROM (EXCLUDED.due_on, EXCLUDED.title)`,
        [organizationId, engagement.customer_id, engagement.id, item.rule.id, item.rule.key, item.rule.revision, item.serviceId,
          item.title, engagement.period_label, item.periodKey, item.dueOn],
      );
      written += result.rowCount;
    }

    // Deadlines of services no longer engaged go — unless already worked on.
    const kept = items.map((item) => `${item.rule.id}|${item.periodKey}`);
    const dropped = await client.query(
      `DELETE FROM obligations
       WHERE engagement_id = $1 AND source = 'generated' AND status = 'pending'
         AND (rule_id::text || '|' || period_key) <> ALL($2::text[])`,
      [engagement.id, kept],
    );

    await client.query("COMMIT");

    return { generated: items.length, written, dropped: dropped.rowCount };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Every engagement of a client, or of a whole period, regenerated.
async function generate(organizationId, { engagementId, customerId, period } = {}) {
  if (engagementId) return generateForEngagement(organizationId, engagementId);

  const values = [organizationId];
  const where = ["organization_id = $1"];

  if (customerId) { values.push(customerId); where.push(`customer_id = $${values.length}`); }
  if (period) { values.push(period); where.push(`period_label = $${values.length}`); }

  const engagements = await pool.query(`SELECT id FROM engagements WHERE ${where.join(" AND ")}`, values);
  const total = { generated: 0, written: 0, dropped: 0, engagements: engagements.rows.length };

  for (const row of engagements.rows) {
    const result = await generateForEngagement(organizationId, row.id);
    total.generated += result.generated;
    total.written += result.written;
    total.dropped += result.dropped;
  }

  return total;
}

/*
 * The deadline feed (COMP-04/05): items with their state, sorted overdue
 * first, and the count per state for the cards. Archived clients are left out.
 */
async function feed(organizationId, { period, customerId, state } = {}) {
  const today = await todayFor(organizationId);
  const soon = schedules.addDays(today, DUE_SOON_DAYS);

  const values = [organizationId];
  const where = ["o.organization_id = $1", "c.archived_at IS NULL"];

  if (period) { values.push(period); where.push(`o.period_label = $${values.length}`); }
  if (customerId) { values.push(customerId); where.push(`o.customer_id = $${values.length}`); }

  const result = await pool.query(
    `SELECT o.id, o.customer_id, c.name AS customer_name, o.engagement_id, o.rule_key, o.service_id, s.name AS service_name,
            s.key AS service_key, o.title, o.period_label, o.period_key, o.due_on::text AS due_on, o.status, o.filed_on::text AS filed_on,
            o.source, o.notes
     FROM obligations o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN services s ON s.id = o.service_id
     WHERE ${where.join(" AND ")}`,
    values,
  );

  const items = result.rows.map((row) => ({ ...row, state: stateOf(row, today, soon) }));
  const counts = Object.fromEntries(STATE_ORDER.map((name) => [name, items.filter((item) => item.state === name).length]));

  const shown = state ? items.filter((item) => item.state === state) : items;

  shown.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.due_on.localeCompare(b.due_on) || a.id - b.id);

  return { today, counts, items: shown };
}

/*
 * One client's deadlines for a period, grouped by service with done/total
 * and overdue counts (CD-07).
 */
async function forClient(organizationId, customerId, period) {
  const { today, items } = await feed(organizationId, { customerId, period });
  const groups = new Map();

  for (const item of [...items].sort((a, b) => a.due_on.localeCompare(b.due_on) || a.id - b.id)) {
    const key = item.service_key || "other";

    if (!groups.has(key)) groups.set(key, { serviceKey: item.service_key, serviceName: item.service_name || "Other", items: [] });
    groups.get(key).items.push(item);
  }

  return {
    today,
    period,
    services: [...groups.values()].map((group) => ({
      ...group,
      done: group.items.filter((item) => item.state === "completed").length,
      total: group.items.length,
      overdue: group.items.filter((item) => item.state === "overdue").length,
    })),
  };
}

const STATUSES = ["pending", "in_progress", "filed", "not_applicable"];

async function updateStatus({ organizationId, userId, permissions }, obligationId, input) {
  const found = await pool.query(
    `SELECT o.*, c.locked_at, c.archived_at FROM obligations o JOIN customers c ON c.id = o.customer_id
     WHERE o.id = $1 AND o.organization_id = $2`,
    [obligationId, organizationId],
  );
  const item = found.rows[0];

  if (!item) throw httpError(404, "Deadline not found");
  if (item.archived_at) throw httpError(409, "This client is archived — restore it to make changes");
  if (item.locked_at && !permissions.includes("profiles.lock")) throw httpError(423, "This client is locked");

  const status = input.status ?? item.status;

  if (!STATUSES.includes(status)) throw httpError(400, "Unknown status", { status: STATUSES.join(", ") });

  let filedOn = input.filedOn !== undefined ? input.filedOn : isoDate(item.filed_on);

  if (status === "filed" && !filedOn) filedOn = await todayFor(organizationId);
  if (status !== "filed") filedOn = null;
  if (filedOn && !/^\d{4}-\d{2}-\d{2}$/.test(filedOn)) throw httpError(400, "Filed date must be a date", { filedOn: "Use YYYY-MM-DD" });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE obligations SET status = $1, filed_on = $2, notes = COALESCE($3, notes),
              status_changed_by = $4, status_changed_at = NOW(), updated_at = NOW()
       WHERE id = $5`,
      [status, filedOn, input.notes ?? null, userId, obligationId],
    );

    if (status !== item.status) {
      await client.query(
        `INSERT INTO audit_events (organization_id, actor_user_id, action, entity_type, entity_id, customer_id, details)
         VALUES ($1, $2, 'obligation.status_changed', 'obligation', $3, $4, $5)`,
        [organizationId, userId, String(obligationId), item.customer_id, { from: item.status, to: status, title: item.title }],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// A deadline no rule produces (a hearing, a one-off filing).
async function createManual({ organizationId, userId }, input) {
  const customerId = Number(input.customerId);
  const title = String(input.title || "").trim();

  if (!title) throw httpError(400, "Give the deadline a title", { title: "Required" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn || "")) throw httpError(400, "Enter the due date", { dueOn: "Use YYYY-MM-DD" });

  const client = await pool.query("SELECT id, archived_at FROM customers WHERE id = $1 AND organization_id = $2", [customerId, organizationId]);

  if (!client.rows[0]) throw httpError(404, "Client not found");
  if (client.rows[0].archived_at) throw httpError(409, "This client is archived");

  const created = await pool.query(
    `INSERT INTO obligations (organization_id, customer_id, title, period_label, period_key, due_on, source, notes, status_changed_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7, $8)
     RETURNING id`,
    [organizationId, customerId, title.slice(0, 250), input.period || null, `manual:${input.dueOn}`, input.dueOn, input.notes || null, userId],
  );

  return { id: created.rows[0].id };
}

module.exports = { generate, generateForEngagement, feed, forClient, updateStatus, createManual, stateOf, todayFor, DUE_SOON_DAYS };
