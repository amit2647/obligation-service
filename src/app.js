const express = require("express");
const cors = require("cors");

const healthRoutes = require("./routes/healthRoutes");
const requestLogger = require("./middleware/requestLogger");

/*
 * Obligation service — deadline rules, the obligations they generate per client and period, extensions, and reminders.
 *
 * A capability service of the profession-bundle platform: profession-neutral,
 * configured by the organization's installed bundle. Only /health exists until
 * its milestone adds the routes (see the plan's Part 3).
 */
const app = express();

app.use(cors());
app.use(express.json());

app.use(requestLogger);

app.use(healthRoutes);

module.exports = app;
