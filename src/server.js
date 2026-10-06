const app = require("./app");
const reminders = require("./workers/reminderRunner");

const PORT = process.env.PORT || 4010;

async function startServer() {
  try {
    console.log("[SERVER] Starting obligation-service...");

    reminders.start();

    app.listen(PORT, () => {
      console.log(`[SERVER] Obligation service running on port ${PORT}`);
    });
  } catch (error) {
    console.error("[SERVER] Obligation service startup failed");

    console.error(error);

    process.exit(1);
  }
}

startServer();
