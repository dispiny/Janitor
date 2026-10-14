import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadDotEnv } from "./load-env.js";

describe("loadDotEnv", () => {
  it("loads keys from .env without overriding existing env", () => {
    const dir = mkdtempSync(join(tmpdir(), "janitor-env-"));
    writeFileSync(
      join(dir, ".env"),
      [
        "# comment",
        "AGENT_TOKEN=from-file",
        "export PORT=3930",
        "HOST='127.0.0.1'",
        "CF_TUNNEL_HOSTNAME=\"agent.example.com\"",
      ].join("\n"),
    );

    process.env.AGENT_TOKEN = "already-set";
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.CF_TUNNEL_HOSTNAME;

    loadDotEnv(dir);

    assert.equal(process.env.AGENT_TOKEN, "already-set");
    assert.equal(process.env.PORT, "3930");
    assert.equal(process.env.HOST, "127.0.0.1");
    assert.equal(process.env.CF_TUNNEL_HOSTNAME, "agent.example.com");

    delete process.env.AGENT_TOKEN;
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.CF_TUNNEL_HOSTNAME;
  });
});
