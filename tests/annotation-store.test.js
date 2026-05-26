"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AnnotationStore } = require("../src/annotation-store");
const { WebhookNotifier, normalizeUrls } = require("../src/notifier");

test("annotation store creates, resolves, and hides resolved records by default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "status-annotations-"));
  const store = new AnnotationStore({ filePath: path.join(dir, "annotations.json") });

  const created = store.create({
    title: "线路波动",
    body: "上游出现短时超时，正在观察。",
    level: "warning",
    targetId: "api-1",
    notify: false
  });

  assert.match(created.id, /^note-/);
  assert.equal(created.level, "warning");
  assert.equal(store.listForSnapshot().length, 1);

  const resolved = store.resolve(created.id);
  assert.equal(resolved.status, "resolved");
  assert.equal(store.listForSnapshot().length, 0);
  assert.equal(store.list({ includeResolved: true }).length, 1);
});

test("annotation store validates level, target id, and text length", () => {
  const store = new AnnotationStore({ filePath: "" });

  assert.throws(
    () => store.create({ title: "ok", body: "body", level: "bad" }),
    /级别不支持/
  );
  assert.throws(
    () => store.create({ title: "ok", body: "body", targetId: "../bad" }),
    /关联检测项 ID 不合法/
  );
  assert.throws(
    () => store.create({ title: "", body: "body" }),
    /标题不能为空/
  );
});

test("notification URL parser accepts http URLs and rejects unsupported protocols", () => {
  assert.deepEqual(
    normalizeUrls("https://example.com/hook, http://127.0.0.1:9000/hook"),
    ["https://example.com/hook", "http://127.0.0.1:9000/hook"]
  );
  assert.throws(() => normalizeUrls("file:///tmp/hook"), /http or https/);
});

test("webhook notifier is disabled when no webhook URL is configured", async () => {
  const notifier = new WebhookNotifier({ urls: "" });

  assert.equal(notifier.enabled, false);
  assert.deepEqual(await notifier.notifyAnnotation({ title: "test" }), []);
});
