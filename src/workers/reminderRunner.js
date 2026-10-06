const jwt = require("jsonwebtoken");
const { schedules } = require("bundle-sdk");

const pool = require("../config/database");

/*
 * Deadline reminders. Periodically, for every organization with a bundle,
 * finds open deadlines due within REMINDER_DAYS (obligation.due_soon) or
 * already overdue within OVERDUE_WINDOW_DAYS (obligation.overdue), and
 * raises the event with email-service, which runs any automation the firm
 * has switched on.
 *
 * There is no user here, so no user token to forward. Instead it signs a
 * narrow service token (SERVICE_JWT_SECRET, scope automations.trigger, one
 * organization, five minutes) that email-service accepts on its trigger
 * route and nowhere else. Without SERVICE_JWT_SECRET the runner stays off.
 *
 * Each reminder carries a dedupe key (obligation:<id>:due_soon), so running
 * every hour — or on several replicas — sends it at most once.
 */

const EMAIL_SERVICE_URL = process.env.EMAIL_SERVICE_URL || "http://email-service:4006";
const INTERVAL_MS = Number(process.env.OBLIGATION_REMINDER_INTERVAL_MS || 60 * 60 * 1000);
const REMINDER_DAYS = 7;
const OVERDUE_WINDOW_DAYS = 30;
const BATCH = 200;

function serviceToken(organizationId) {
  return jwt.sign(
    { service: "obligation-service", organizationId, scope: "automations.trigger" },
    process.env.SERVICE_JWT_SECRET,
    { issuer: "omnicore-services", expiresIn: "5m" },
  );
}

const formatDay = (value) => {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
};

async function trigger(organizationId, event, dedupeKey, payload) {
  const response = await fetch(`${EMAIL_SERVICE_URL}/emails/automations/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceToken(organizationId)}` },
    body: JSON.stringify({ event, dedupe_key: dedupeKey, payload }),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`email-service refused ${event} (${response.status})`);
  }
}

/*
 * One pass. Exposed for the "run now" route and the tests; returns how many
 * reminders were raised.
 */
async function runOnce({ organizationId } = {}) {
  if (!process.env.SERVICE_JWT_SECRET) {
    return { raised: 0, skipped: "SERVICE_JWT_SECRET is not set" };
  }

  const organizations = await pool.query(
    `SELECT o.id, o.time_zone FROM organizations o
     JOIN organization_bundles ob ON ob.organization_id = o.id AND ob.status = 'installed'
     WHERE ($1::int IS NULL OR o.id = $1)`,
    [organizationId || null],
  );

  let raised = 0;

  for (const organization of organizations.rows) {
    const today = schedules.todayIn(organization.time_zone || "UTC");
    const due = await pool.query(
      `SELECT o.id, o.title, o.due_on::text AS due_on, o.period_label, c.id AS customer_id, c.name AS customer_name, c.email AS customer_email
       FROM obligations o JOIN customers c ON c.id = o.customer_id
       WHERE o.organization_id = $1 AND o.status IN ('pending', 'in_progress') AND c.archived_at IS NULL
         AND c.email IS NOT NULL AND c.email <> ''
         AND o.due_on BETWEEN $2::date AND $3::date
       ORDER BY o.due_on
       LIMIT $4`,
      [organization.id, schedules.addDays(today, -OVERDUE_WINDOW_DAYS), schedules.addDays(today, REMINDER_DAYS), BATCH],
    );

    for (const item of due.rows) {
      const kind = item.due_on < today ? "overdue" : "due_soon";

      try {
        await trigger(organization.id, `obligation.${kind}`, `obligation:${item.id}:${kind}`, {
          client: { id: item.customer_id, name: item.customer_name, email: item.customer_email },
          obligation: { id: item.id, title: item.title, due_on: formatDay(item.due_on), period_label: item.period_label },
        });
        raised += 1;
      } catch (error) {
        console.error(`[Reminders] ${error.message}`);
      }
    }
  }

  return { raised };
}

function start() {
  if (!process.env.SERVICE_JWT_SECRET) {
    console.warn("[Reminders] SERVICE_JWT_SECRET is not set — deadline reminders are off");
    return;
  }

  const tick = async () => {
    try {
      const { raised } = await runOnce();
      if (raised > 0) console.log(`[Reminders] Raised ${raised} reminder event(s)`);
    } catch (error) {
      console.error("[Reminders] Pass failed:", error.message);
    }
  };

  setTimeout(tick, 30 * 1000).unref();
  setInterval(tick, INTERVAL_MS).unref();
}

module.exports = { runOnce, start, serviceToken };
