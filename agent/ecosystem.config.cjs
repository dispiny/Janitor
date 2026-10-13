/** From agent/: `pm2 start ecosystem.config.cjs` */
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "janitor-agent",
      cwd: __dirname,
      script: "src/index.ts",
      interpreter: "node",
      // Resolve local node_modules/tsx (do not rely on a global `tsx` binary)
      interpreter_args: `--import ${path.join(__dirname, "node_modules/tsx/dist/loader.mjs")}`,
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "5s",
      env: {
        NODE_ENV: "production",
        AGENT_ALLOW_REMOTE_UPDATE: "true",
        PM2_APP_NAME: "janitor-agent",
      },
    },
  ],
};
