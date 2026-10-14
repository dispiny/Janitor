/** From agent/: `pm2 start ecosystem.config.cjs` */
const path = require("node:path");

const loader = path.join(__dirname, "node_modules/tsx/dist/loader.mjs");

module.exports = {
  apps: [
    {
      name: "janitor-agent",
      cwd: __dirname,
      script: "src/index.ts",
      interpreter: "node",
      // Absolute local loader — survives PATH issues after npm/pm2 restart
      interpreter_args: `--import ${loader}`,
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      min_uptime: "5s",
      env: {
        NODE_ENV: "production",
        AGENT_ALLOW_REMOTE_UPDATE: "true",
        AGENT_DEPLOY_ON_UPDATE: "true",
        PM2_APP_NAME: "janitor-agent",
        // Set in agent/.env or pm2 env: CLOUDFLARE_API_TOKEN=...
      },
    },
  ],
};
