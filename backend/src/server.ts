import "./seed.js"; // first: puts the seed store in place before the store is read
import { createApp } from "./app.js";
import { adminPasscodeIsSet } from "./auth.js";
import { markInterruptedRuns } from "./agent/agent.js";
import { config } from "./config.js";
import { startNavScheduler } from "./nav.js";
import { startScheduleWatcher } from "./schedule.js";

markInterruptedRuns();

createApp().listen(config.port, "0.0.0.0", () => {
  console.log(`Udhaar API listening on 0.0.0.0:${config.port} (testnet)`);
  console.log(`Watchers: schedule ${process.env.SCHEDULE_WATCHER === "off" ? "off" : "on"}, NAV ${process.env.NAV_SCHEDULER === "off" ? "off" : "on"}. Run only one backend with them on.`);
  startNavScheduler();
  startScheduleWatcher();
  if (!adminPasscodeIsSet()) console.warn("DEMO_ADMIN_PASSCODE is not set, so admin login is off and admin routes stay locked.");
});
