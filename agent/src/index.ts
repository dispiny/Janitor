import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { loadDotEnv } from "./load-env.js";
import { log } from "./log.js";
import { startPoller } from "./poller.js";

// A stray rejection (e.g. a fire-and-forget fetch) must not take the agent down silently.
process.on("unhandledRejection", (reason) => {
  log("process.unhandled_rejection", {
    phase: "failed",
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
// Unknown state after an uncaught exception: log, then exit so pm2 restarts cleanly.
process.on("uncaughtException", (error) => {
  log("process.uncaught_exception", { phase: "failed", error: error.message, stack: error.stack });
  process.exit(1);
});

loadDotEnv();
const config = readConfig();
const app = createApp(config);

serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  },
  (info) => {
    console.log(
      JSON.stringify({
        event: "listening",
        host: config.host,
        port: info.port,
        tunnelHostname: config.tunnelHostname ?? null,
        polling: Boolean(config.janitorApiUrl),
      }),
    );
  },
);

if (config.janitorApiUrl) {
  startPoller({
    ...config,
    janitorApiUrl: config.janitorApiUrl,
  });
}
