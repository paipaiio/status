"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAdminAuth } = require("../src/admin-auth");
const { HealthMonitor } = require("../src/checker");
const { ManagedTargetStore } = require("../src/target-store");

test("admin auth creates httpOnly same-site sessions", () => {
  const auth = createAdminAuth({
    username: "root",
    password: "Admin@123",
    ttlMs: 60000
  });

  assert.equal(auth.verifyCredentials({ username: "root", password: "Admin@123" }), true);
  assert.equal(auth.verifyCredentials({ username: "root", password: "bad" }), false);

  const req = { headers: {}, socket: {} };
  const res = { setHeader(name, value) { this[name] = value; } };
  const session = auth.createSession();
  auth.setSessionCookie(req, res, session);

  assert.match(res["Set-Cookie"], /status_admin=/);
  assert.match(res["Set-Cookie"], /HttpOnly/);
  assert.match(res["Set-Cookie"], /SameSite=Strict/);

  const authedReq = { headers: { cookie: res["Set-Cookie"].split(";")[0] }, socket: {} };
  assert.equal(auth.getSession(authedReq).username, "root");
});

test("managed target store persists records without exposing full api key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "status-targets-"));
  const store = new ManagedTargetStore({ filePath: path.join(dir, "targets.json") });

  const created = store.create(
    {
      name: "Dynamic Relay",
      baseUrl: "api.example.com",
      model: "model-test",
      apiKey: "sk-1234567890",
      format: "openai",
      checkMode: "models"
    },
    new Set(),
    0
  );

  assert.equal(created.target.id, created.record.id);
  assert.equal(store.listSafe()[0].apiKeyMask, "sk-1...7890");

  const reloaded = new ManagedTargetStore({ filePath: path.join(dir, "targets.json") });
  assert.equal(reloaded.listSafe().length, 1);
  assert.equal(reloaded.listSafe()[0].hasApiKey, true);
  assert.equal(reloaded.listSafe()[0].apiKey, undefined);
});

test("health monitor can add and remove targets at runtime", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    status: 200,
    async json() {
      return { data: [{ id: "model-test" }] };
    }
  });

  const target = new ManagedTargetStore({
    filePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "status-runtime-")), "targets.json")
  }).create(
    {
      name: "Runtime Relay",
      baseUrl: "api.example.com",
      model: "model-test",
      apiKey: "secret",
      format: "openai",
      checkMode: "models",
      intervalSeconds: 60
    },
    new Set(),
    0
  ).target;

  const monitor = new HealthMonitor([], { onUpdate() {} });
  try {
    monitor.addTarget(target);
    await monitor.runCheck(target.id);

    assert.equal(monitor.getSnapshot().summary.total, 1);
    assert.equal(monitor.getSnapshot().checks[0].status, "up");
    assert.equal(monitor.removeTarget(target.id), true);
    assert.equal(monitor.getSnapshot().summary.total, 0);
  } finally {
    monitor.stop();
    global.fetch = originalFetch;
  }
});
