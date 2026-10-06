const express = require("express");
const cors = require("cors");

const healthRoutes = require("./routes/healthRoutes");
const obligationRoutes = require("./routes/obligationRoutes");
const requestLogger = require("./middleware/requestLogger");

/*
 * Obligation service: compliance deadlines — the bundle's rules, extensions
 * per period, the deadlines generated from what each client engaged, and the
 * reminders raised as they come due.
 */
const app = express();

app.use(cors());
app.use(express.json());

app.use(requestLogger);

app.use(healthRoutes);
app.use(obligationRoutes);

module.exports = app;
