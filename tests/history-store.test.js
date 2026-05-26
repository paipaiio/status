"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { HealthMonitor } = require("../src/checker");
const { JsonHistoryStore } = require("../src/history-store");

test("health monitor restores history and computes availability windows", () => {
  const now = Date.now();
  const target = {
    id: "relay",
    name: "Relay",
    group: "核心模型",
    description: "模型列表探测",
    format: "openai",
    model: "model-test",
    checkMode: "models",
    method: "GET",
    intervalMs: 60000,
    allowedLatencyMs: 3000
  };
  const historyStore = {
    load() {
      return {
        relay: [
          { at: new Date(now - 70 * 60 * 1000).toISOString(), status: "up", latencyMs: 800, statusCode: 200 },
          { at: new Date(now - 35 * 60 * 1000).toISOString(), status: "degraded", latencyMs: 4100, statusCode: 200 },
          { at: new Date(now - 5 * 60 * 1000).toISOString(), status: "down", latencyMs: null, statusCode: 500 }
        ]
      };
    },
    append() {}
  };

  const monitor = new HealthMonitor([target], { historyStore });
  const [check] = monitor.getSnapshot().checks;

  assert.equal(check.status, "down");
  assert.equal(check.availability["90m"].sampleCount, 3);
  assert.equal(check.availability["90m"].availabilityPct, 66.67);
  assert.equal(check.annotation.level, "critical");
});

test("json history store persists and prunes records", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "status-history-"));
  const filePath = path.join(dir, "history.json");
  const store = new JsonHistoryStore({
    filePath,
    retentionMs: 60 * 60 * 1000,
    maxRecordsPerTarget: 2
  });

  store.append("relay", {
    at: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
    status: "up",
    latencyMs: 100,
    statusCode: 200
  });
  store.append("relay", {
    at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    status: "degraded",
    latencyMs: 3200,
    statusCode: 200
  });
  store.append("relay", {
    at: new Date().toISOString(),
    status: "down",
    latencyMs: null,
    statusCode: 500
  });

  const reloaded = new JsonHistoryStore({ filePath });

  assert.equal(reloaded.data.relay.length, 2);
  assert.equal(reloaded.data.relay[0].status, "degraded");
  assert.equal(reloaded.data.relay[1].status, "down");
});
