"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCapturePageUrl,
  buildScreenshotMessage,
  buildStatusApiUrl,
  createCapturePlan,
  createConfig,
  encodeFrame,
  extractMessageText,
  getSharedCapture,
  isGroupAdmin,
  isSettingsCommand,
  parseFrames,
  resolveBotIntent,
  shouldHandleEvent
} = require("../src/qq-status-bot");

test("createConfig keeps the listener local by default", () => {
  const config = createConfig({ PORT: "3210" });

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3211);
  assert.equal(config.path, "/onebot");
  assert.equal(config.statusPageUrl, "http://127.0.0.1:3210/");
  assert.equal(config.screenshotHeight, 1280);
  assert.equal(config.capturePerPage, 4);
});

test("buildStatusApiUrl points screenshots at the status API origin", () => {
  assert.equal(
    buildStatusApiUrl("https://status.example.com/?capture=qq"),
    "https://status.example.com/api/status"
  );
});

test("buildCapturePageUrl adds capture pagination parameters", () => {
  const url = new URL(
    buildCapturePageUrl(
      {
        statusPageUrl: "https://status.example.com/?capture=qq",
        capturePerPage: 4,
        captureWindow: "24h"
      },
      2,
      3,
      10
    )
  );

  assert.equal(url.searchParams.get("capture"), "qq");
  assert.equal(url.searchParams.get("capturePage"), "2");
  assert.equal(url.searchParams.get("capturePages"), "3");
  assert.equal(url.searchParams.get("capturePerPage"), "4");
  assert.equal(url.searchParams.get("captureTotal"), "10");
  assert.equal(url.searchParams.get("window"), "24h");
});

test("createCapturePlan splits large status pages into readable screenshots", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    async json() {
      return { checks: Array.from({ length: 10 }, (_item, index) => ({ id: `api-${index}` })) };
    }
  });

  try {
    const plan = await createCapturePlan({
      statusPageUrl: "http://127.0.0.1:3210/?capture=qq",
      capturePerPage: 4,
      captureMaxPages: 8,
      captureWindow: "90m"
    });

    assert.equal(plan.totalChecks, 10);
    assert.equal(plan.pageCount, 3);
    assert.equal(plan.pages.length, 3);
    assert.match(plan.pages[2].url, /capturePage=3/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("buildScreenshotMessage labels multi-page screenshot batches", () => {
  assert.equal(buildScreenshotMessage(1), "状态检查截图如下：");
  assert.equal(buildScreenshotMessage(3), "状态检查截图如下（共 3 张）：");
});

test("getSharedCapture shares concurrent screenshot work and caches briefly", async () => {
  const state = { captureJob: null, captureCache: null };
  let calls = 0;
  const factory = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return [`image-${calls}`];
  };

  const [first, second] = await Promise.all([
    getSharedCapture(state, factory, { cacheMs: 1000 }),
    getSharedCapture(state, factory, { cacheMs: 1000 })
  ]);
  const cached = await getSharedCapture(state, factory, { cacheMs: 1000 });

  assert.deepEqual(first, ["image-1"]);
  assert.deepEqual(second, ["image-1"]);
  assert.deepEqual(cached, ["image-1"]);
  assert.equal(calls, 1);
});

test("shouldHandleEvent matches group messages with the trigger", () => {
  const event = {
    post_type: "message",
    message_type: "group",
    group_id: 123456,
    raw_message: "状态检查"
  };

  assert.equal(shouldHandleEvent(event, "状态检查"), true);
});

test("shouldHandleEvent ignores private messages and fuzzy trigger text", () => {
  assert.equal(shouldHandleEvent({
    post_type: "message",
    message_type: "private",
    user_id: 1,
    raw_message: "状态检查"
  }), false);

  assert.equal(shouldHandleEvent({
    post_type: "message",
    message_type: "group",
    group_id: 1,
    raw_message: "麻烦状态检查一下"
  }), false);
});

test("resolveBotIntent lets only admins use settings commands", () => {
  const memberEvent = {
    post_type: "message",
    message_type: "group",
    group_id: 1,
    raw_message: "状态检查 设置",
    sender: { role: "member" }
  };
  const adminEvent = {
    ...memberEvent,
    sender: { role: "admin" }
  };

  assert.deepEqual(resolveBotIntent(memberEvent), { type: "ignore" });
  assert.deepEqual(resolveBotIntent(adminEvent), { type: "settings" });
});

test("isGroupAdmin recognizes group owners and admins only", () => {
  assert.equal(isGroupAdmin({ sender: { role: "owner" } }), true);
  assert.equal(isGroupAdmin({ sender: { role: "admin" } }), true);
  assert.equal(isGroupAdmin({ sender: { role: "member" } }), false);
});

test("isSettingsCommand recognizes status settings prefixes", () => {
  assert.equal(isSettingsCommand("状态检查设置"), true);
  assert.equal(isSettingsCommand("/状态检查 设置 查看"), true);
  assert.equal(isSettingsCommand("状态检查"), false);
});

test("extractMessageText supports array-format OneBot segments", () => {
  const event = {
    message: [
      { type: "at", data: { qq: "123" } },
      { type: "text", data: { text: "状态" } },
      { type: "text", data: { text: "检查" } }
    ]
  };

  assert.equal(extractMessageText(event), "状态检查");
});

test("parseFrames handles fragmented websocket data", () => {
  const client = { buffer: Buffer.alloc(0), fragments: [] };
  const frame = encodeFrame(Buffer.from("ok"), 0x1);

  const framesA = parseFrames(client, frame.subarray(0, 1));
  const framesB = parseFrames(client, frame.subarray(1));

  assert.deepEqual(framesA, []);
  assert.equal(framesB.length, 1);
  assert.equal(framesB[0].payload.toString("utf8"), "ok");
});
