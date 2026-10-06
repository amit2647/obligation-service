const express = require("express");

const authenticate = require("../middleware/authenticate");
const requirePermission = require("../middleware/requirePermission");
const requireBundle = require("../middleware/requireBundle");
const pool = require("../config/database");
const ruleService = require("../services/ruleService");
const obligationService = require("../services/obligationService");
const reminders = require("../workers/reminderRunner");
const { choicesOf } = require("../services/bundleSync");

const router = express.Router();

/*
 * Compliance deadlines (COMP-01–07, CD-07, FIX-20). Every route but the
 * install step answers only an organization with a profession bundle.
 */

const KEY = /^[a-z][a-z0-9-]{1,59}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

function respond(handler) {
  return async (req, res) => {
    try {
      const result = await handler(req, res);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (error) {
      if (!error.statusCode) console.error("[Obligations]", error);
      res.status(error.statusCode || 500).json({
        error: error.statusCode ? error.message : "The deadline request failed",
        ...(error.details ? { details: error.details } : {}),
      });
    }
  };
}

function id(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    const error = new Error("Invalid id");
    error.statusCode = 400;
    throw error;
  }
  return number;
}

// Generation follows engagement changes, so either permission may ask for it.
function requireAny(...permissions) {
  return (req, res, next) =>
    permissions.some((permission) => req.auth.permissions.includes(permission))
      ? next()
      : res.status(403).json({ error: "Insufficient permissions", requiredPermission: permissions.join(" or ") });
}

const auth = (req) => ({ organizationId: req.auth.organizationId, userId: req.auth.userId, permissions: req.auth.permissions });
const gated = (permission) => [authenticate, requirePermission(permission), requireBundle];

// The rules step of a bundle install (runs before the install has finished).
router.put(
  "/obligations/bundles/:key/:version",
  authenticate,
  requirePermission("bundles.manage"),
  respond((req) => {
    const { key, version } = req.params;

    if (!KEY.test(key) || !VERSION.test(version)) {
      const error = new Error("Invalid bundle key or version");
      error.statusCode = 400;
      throw error;
    }

    return ruleService.installRules(req.auth.organizationId, key, version, req.body?.obligations || [], choicesOf(req));
  }),
);

router.post(
  "/obligations/generate",
  authenticate,
  requireAny("engagements.update", "obligations.update"),
  requireBundle,
  respond((req) =>
    obligationService.generate(req.auth.organizationId, {
      engagementId: req.body?.engagementId ? id(req.body.engagementId) : null,
      customerId: req.body?.customerId ? id(req.body.customerId) : null,
      period: req.body?.period || null,
    }),
  ),
);

router.get("/obligations/rules", ...gated("obligations.read"), respond((req) => ruleService.listRules(req.auth.organizationId)));

router.patch(
  "/obligations/rules/:key",
  ...gated("obligations.rules"),
  respond((req) => ruleService.setActive(req.auth.organizationId, req.params.key, req.body?.isActive)),
);

router.put(
  "/obligations/rules/:key/overrides/:periodKey",
  ...gated("obligations.rules"),
  respond((req) => ruleService.setOverride(auth(req), req.params.key, req.params.periodKey, req.body?.dueOn, req.body?.reason)),
);

router.delete(
  "/obligations/rules/:key/overrides/:periodKey",
  ...gated("obligations.rules"),
  respond(async (req) => {
    const rule = await ruleService.getRule(req.auth.organizationId, req.params.key);
    await ruleService.removeOverride(req.auth.organizationId, req.params.key, req.params.periodKey);

    // Back to the computed date for the deadlines that had moved.
    const affected = await pool.query(
      "SELECT DISTINCT engagement_id FROM obligations WHERE rule_id = $1 AND period_key = $2 AND engagement_id IS NOT NULL",
      [rule.id, req.params.periodKey],
    );

    for (const row of affected.rows) {
      await obligationService.generateForEngagement(req.auth.organizationId, row.engagement_id);
    }
  }),
);

// Raise any reminders due now, for this organization (also runs on a timer).
router.post(
  "/obligations/reminders/run",
  ...gated("obligations.rules"),
  respond((req) => reminders.runOnce({ organizationId: req.auth.organizationId })),
);

router.get(
  "/obligations/customers/:customerId",
  ...gated("obligations.read"),
  respond((req) => obligationService.forClient(req.auth.organizationId, id(req.params.customerId), req.query.period || null)),
);

router.get(
  "/obligations",
  ...gated("obligations.read"),
  respond((req) =>
    obligationService.feed(req.auth.organizationId, {
      period: req.query.period || null,
      customerId: req.query.customerId ? id(req.query.customerId) : null,
      state: req.query.state || null,
    }),
  ),
);

router.post(
  "/obligations",
  ...gated("obligations.update"),
  respond(async (req, res) => {
    res.status(201);
    return obligationService.createManual(auth(req), req.body || {});
  }),
);

router.patch(
  "/obligations/:id",
  ...gated("obligations.update"),
  respond((req) => obligationService.updateStatus(auth(req), id(req.params.id), req.body || {})),
);

module.exports = router;
