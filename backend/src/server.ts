import { createApp } from "./app.js";
import { adminPasscodeIsSet } from "./auth.js";
import { config } from "./config.js";

createApp().listen(config.port, () => {
  console.log(`Udhaar API listening on http://localhost:${config.port} (testnet)`);
  if (!adminPasscodeIsSet()) console.warn("DEMO_ADMIN_PASSCODE is not set, so admin login is off and admin routes stay locked.");
});
