#!/usr/bin/env node
/**
 * Deploy Worker while preserving dashboard Variables and optional custom domain.
 * Personal hostnames stay out of git — pass them via env on the deploy host.
 *
 *   CLOUDFLARE_API_TOKEN=...
 *   CLOUDFLARE_CUSTOM_DOMAIN=ops.example.com   # optional
 *   CLOUDFLARE_ZONE_NAME=example.com           # optional, with custom domain
 *
 * Writes a temporary config next to the repo root (not under /tmp) so wrangler
 * resolves `main` / `assets.directory` relative to the project.
 */
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const domain = process.env.CLOUDFLARE_CUSTOM_DOMAIN?.trim();
const zone = process.env.CLOUDFLARE_ZONE_NAME?.trim();

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, CI: process.env.CI || "1" },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

const basePath = join(root, "wrangler.jsonc");
const raw = await readFile(basePath, "utf8");
// Strip // comments for JSON.parse (wrangler.jsonc is comment-friendly; we only need a patch copy).
const jsonText = raw.replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1");
const config = JSON.parse(jsonText);
config.keep_vars = true;

if (domain) {
  if (!zone) {
    console.error("CLOUDFLARE_CUSTOM_DOMAIN is set but CLOUDFLARE_ZONE_NAME is missing");
    process.exit(1);
  }
  config.routes = [
    {
      pattern: domain,
      zone_name: zone,
      custom_domain: true,
    },
  ];
  console.log(JSON.stringify({ event: "deploy.routes", domain, zone }));
}

// Must live in the project root — wrangler resolves entry/assets relative to the config file.
const cfgPath = join(root, ".wrangler.deploy.json");
try {
  await writeFile(cfgPath, `${JSON.stringify(config, null, 2)}\n`);
  await run("npx", ["wrangler", "deploy", "--config", cfgPath, "--keep-vars"], root);
} finally {
  await unlink(cfgPath).catch(() => undefined);
}
