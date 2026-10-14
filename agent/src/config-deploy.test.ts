import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readConfig } from "./config.js";

const base = {
  AGENT_TOKEN: "tok",
  PORT: "3920",
};

describe("deployOnUpdate config", () => {
  it("defaults to on when remote update is enabled", () => {
    const cfg = readConfig({ ...base, AGENT_ALLOW_REMOTE_UPDATE: "true" });
    assert.equal(cfg.allowRemoteUpdate, true);
    assert.equal(cfg.deployOnUpdate, true);
  });

  it("can be turned off explicitly", () => {
    const cfg = readConfig({
      ...base,
      AGENT_ALLOW_REMOTE_UPDATE: "true",
      AGENT_DEPLOY_ON_UPDATE: "false",
    });
    assert.equal(cfg.deployOnUpdate, false);
  });
});
