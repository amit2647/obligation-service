const express = require("express");

const pool = require("../config/database");

const router = express.Router();

// Healthy means able to serve: the database must answer, since every route
// this service will have reads it.
router.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({ service: "obligation-service", status: "ok", database: "postgresql" });
  } catch (error) {
    console.error("[HEALTH] Database check failed:", error.message);

    res.status(503).json({ service: "obligation-service", status: "error", database: "unreachable" });
  }
});

module.exports = router;
