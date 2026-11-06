import { createApp } from "./app.js";
import { adminPasscodeIsSet } from "./auth.js";
import { markInterruptedRuns } from "./agent/agent.js";
import { config } from "./config.js";
import { startNavScheduler } from "./nav.js";
import { startScheduleWatcher } from "./schedule.js";

markInterruptedRuns();

createApp().listen(config.port, () => {
  console.log(`Udhaar API listening on http://localhost:${config.port} (testnet)`);
  startNavScheduler();
  startScheduleWatcher();
  if (!adminPasscodeIsSet()) console.warn("DEMO_ADMIN_PASSCODE is not set, so admin login is off and admin routes stay locked.");
});
