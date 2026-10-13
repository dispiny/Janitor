/** pm2: `pm2 start ecosystem.config.cjs` from the agent/ directory */
module.exports = {
  apps: [
    {
      name: "ops-agent",
      script: "src/index.ts",
      interpreter: "node",
      interpreter_args: "--import tsx",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        // Prefer a real .env file next to this config (loaded by the agent).
        AGENT_ALLOW_REMOTE_UPDATE: "true",
        PM2_APP_NAME: "ops-agent",
      },
    },
  ],
};
