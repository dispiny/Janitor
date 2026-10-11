import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";

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
      }),
    );
  },
);
