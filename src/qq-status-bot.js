"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const {
  createWebSocketAccept,
  encodeTextFrame
} = require("./socket");

const execFileAsync = promisify(execFile);

const DEFAULT_TRIGGER = "状态检查";
const DEFAULT_SCREENSHOT_WIDTH = 1080;
const DEFAULT_SCREENSHOT_HEIGHT = 1280;
const DEFAULT_CAPTURE_PER_PAGE = 4;
const DEFAULT_CAPTURE_MAX_PAGES = 8;
const DEFAULT_COOLDOWN_MS = 30000;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const ADMIN_ROLES = new Set(["owner", "admin"]);

function createConfig(env = process.env) {
  const port = Number.parseInt(env.QQ_BOT_PORT || "3211", 10);
  const statusPort = env.PORT || "3210";

  return {
    host: env.QQ_BOT_HOST || "127.0.0.1",
    port: Number.isFinite(port) ? port : 3211,
    path: env.QQ_BOT_PATH || "/onebot",
    sharedToken: env.ONEBOT_SHARED_TOKEN || env.QQ_BOT_TOKEN || "",
    trigger: env.QQ_BOT_TRIGGER || DEFAULT_TRIGGER,
    statusPageUrl: env.STATUS_PAGE_URL || `http://127.0.0.1:${statusPort}/`,
    chromiumBin: env.CHROMIUM_BIN || "chromium",
    runtimeDir: env.QQ_BOT_RUNTIME_DIR || path.join(process.cwd(), "runtime"),
    screenshotWidth: toPositiveInt(env.STATUS_SCREENSHOT_WIDTH, DEFAULT_SCREENSHOT_WIDTH),
    screenshotHeight: toPositiveInt(env.STATUS_SCREENSHOT_HEIGHT, DEFAULT_SCREENSHOT_HEIGHT),
    screenshotWaitMs: toPositiveInt(env.STATUS_SCREENSHOT_WAIT_MS, 3500),
    captureTimeoutMs: toPositiveInt(env.STATUS_CAPTURE_TIMEOUT_MS, 20000),
    capturePerPage: toPositiveInt(env.STATUS_CAPTURE_PER_PAGE, DEFAULT_CAPTURE_PER_PAGE),
    captureMaxPages: toPositiveInt(env.STATUS_CAPTURE_MAX_PAGES, DEFAULT_CAPTURE_MAX_PAGES),
    captureWindow: env.STATUS_CAPTURE_WINDOW || "90m",
    cooldownMs: toPositiveInt(env.QQ_BOT_COOLDOWN_MS, DEFAULT_COOLDOWN_MS)
  };
}

function toPositiveInt(value, fallback) {
  const number = Number.parseInt(value || "", 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function startServer(config = createConfig()) {
  const state = {
    clients: new Set(),
    groupCooldowns: new Map(),
    activeGroups: new Set()
  };

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, clients: state.clients.size }));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  server.on("upgrade", (req, socket) => {
    handleUpgrade(req, socket, config, state);
  });

  server.listen(config.port, config.host, () => {
    log(`QQ status bot listening on ${config.host}:${config.port}${config.path}`);
    log(`Watching group messages for trigger: ${config.trigger}`);
  });

  return { server, state };
}

function handleUpgrade(req, socket, config, state) {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (requestUrl.pathname !== config.path) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!isAuthorized(req, config.sharedToken)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade || "").toLowerCase();
  if (!key || upgrade !== "websocket") {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const handshake = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${createWebSocketAccept(key)}`,
    "\r\n"
  ].join("\r\n");

  const client = {
    socket,
    buffer: Buffer.alloc(0),
    fragments: [],
    closed: false
  };

  socket.setNoDelay(true);
  state.clients.add(client);
  socket.write(handshake);
  log("NapCat OneBot websocket connected");

  socket.on("data", (chunk) => {
    try {
      const frames = parseFrames(client, chunk);
      for (const frame of frames) {
        handleFrame(client, frame, config, state);
      }
    } catch (error) {
      log("WebSocket frame error:", error.message);
      closeClient(client, state);
    }
  });

  socket.on("close", () => removeClient(client, state));
  socket.on("end", () => removeClient(client, state));
  socket.on("error", () => removeClient(client, state));
}

function isAuthorized(req, sharedToken) {
  if (!sharedToken) return true;
  const authorization = String(req.headers.authorization || "");
  return authorization === `Bearer ${sharedToken}`;
}

function parseFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  const frames = [];
  let offset = 0;

  while (offset + 2 <= client.buffer.length) {
    const frameStart = offset;
    const firstByte = client.buffer[offset++];
    const secondByte = client.buffer[offset++];
    const fin = Boolean(firstByte & 0x80);
    const opcode = firstByte & 0x0f;
    const masked = Boolean(secondByte & 0x80);
    let length = secondByte & 0x7f;

    if (length === 126) {
      if (offset + 2 > client.buffer.length) {
        offset = frameStart;
        break;
      }
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > client.buffer.length) {
        offset = frameStart;
        break;
      }
      const bigLength = client.buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(MAX_MESSAGE_BYTES)) {
        throw new Error("WebSocket message is too large");
      }
      length = Number(bigLength);
      offset += 8;
    }

    if (length > MAX_MESSAGE_BYTES) {
      throw new Error("WebSocket message is too large");
    }

    let mask;
    if (masked) {
      if (offset + 4 > client.buffer.length) {
        offset = frameStart;
        break;
      }
      mask = client.buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (offset + length > client.buffer.length) {
      offset = frameStart;
      break;
    }

    let payload = client.buffer.subarray(offset, offset + length);
    offset += length;

    if (masked) {
      payload = Buffer.from(payload);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }

    frames.push({ fin, opcode, payload });
  }

  client.buffer = client.buffer.subarray(offset);
  return frames;
}

function handleFrame(client, frame, config, state) {
  if (frame.opcode === 0x8) {
    closeClient(client, state);
    return;
  }

  if (frame.opcode === 0x9) {
    client.socket.write(encodeFrame(frame.payload, 0xA));
    return;
  }

  if (frame.opcode === 0xA) {
    return;
  }

  if (frame.opcode === 0x0) {
    client.fragments.push(frame.payload);
    if (frame.fin) {
      const payload = Buffer.concat(client.fragments);
      client.fragments = [];
      handleTextMessage(client, payload.toString("utf8"), config, state);
    }
    return;
  }

  if (frame.opcode !== 0x1) {
    return;
  }

  if (!frame.fin) {
    client.fragments = [frame.payload];
    return;
  }

  handleTextMessage(client, frame.payload.toString("utf8"), config, state);
}

function handleTextMessage(client, text, config, state) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    log("Ignoring non-JSON websocket message");
    return;
  }

  if (payload.echo && payload.status) {
    log(`OneBot action response: echo=${payload.echo}, status=${payload.status}, retcode=${payload.retcode}`);
    return;
  }

  const intent = resolveBotIntent(payload, config.trigger);
  if (intent.type === "ignore") {
    return;
  }

  if (intent.type === "settings") {
    handleSettingsCommand(client, payload, config);
    return;
  }

  if (intent.type === "status") {
    handleStatusRequest(client, payload, config, state).catch((error) => {
      log("Status screenshot request failed:", error.message);
    });
  }
}

async function handleStatusRequest(client, event, config, state) {
  const groupId = event.group_id;
  const now = Date.now();
  const lastSentAt = state.groupCooldowns.get(groupId) || 0;

  if (now - lastSentAt < config.cooldownMs) {
    sendGroupText(client, groupId, "状态检查截图刚刚生成过，稍等一下再试。");
    return;
  }

  if (state.activeGroups.has(groupId)) {
    sendGroupText(client, groupId, "正在生成状态检查截图，请稍等。");
    return;
  }

  state.activeGroups.add(groupId);
  state.groupCooldowns.set(groupId, now);

  try {
    const images = await captureStatusScreenshots(config);
    sendGroupMessage(client, groupId, [
      { type: "text", data: { text: buildScreenshotMessage(images.length) } },
      ...images.map((imageBase64) => ({ type: "image", data: { file: `base64://${imageBase64}` } }))
    ]);
    log(`Sent ${images.length} status screenshot(s) to group ${groupId}`);
  } catch (error) {
    sendGroupText(client, groupId, "状态检查截图生成失败，稍后再试。");
    throw error;
  } finally {
    state.activeGroups.delete(groupId);
  }
}

function buildScreenshotMessage(count) {
  return count > 1 ? `状态检查截图如下（共 ${count} 张）：` : "状态检查截图如下：";
}

async function captureStatusScreenshots(config) {
  const plan = await createCapturePlan(config);
  const images = [];

  for (const item of plan.pages) {
    images.push(await captureScreenshot(config, item.url));
  }

  return images;
}

async function createCapturePlan(config) {
  let totalChecks = 0;
  try {
    const response = await fetch(buildStatusApiUrl(config.statusPageUrl), { cache: "no-store" });
    if (response.ok) {
      const payload = await response.json();
      totalChecks = Array.isArray(payload.checks) ? payload.checks.length : Number(payload.summary?.total || 0);
    }
  } catch (error) {
    log("Could not read status API before screenshot:", error.message);
  }

  const perPage = Math.max(1, config.capturePerPage || DEFAULT_CAPTURE_PER_PAGE);
  const maxPages = Math.max(1, config.captureMaxPages || DEFAULT_CAPTURE_MAX_PAGES);
  const pageCount = Math.max(1, Math.min(maxPages, Math.ceil((totalChecks || 1) / perPage)));

  return {
    totalChecks,
    perPage,
    pageCount,
    pages: Array.from({ length: pageCount }, (_item, index) => ({
      page: index + 1,
      url: buildCapturePageUrl(config, index + 1, pageCount, totalChecks)
    }))
  };
}

function buildStatusApiUrl(statusPageUrl) {
  const url = new URL(statusPageUrl);
  url.pathname = "/api/status";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function buildCapturePageUrl(config, page, pageCount, totalChecks = 0) {
  const url = new URL(config.statusPageUrl);
  url.searchParams.set("capture", "qq");
  url.searchParams.set("capturePage", String(page));
  url.searchParams.set("capturePages", String(pageCount));
  url.searchParams.set("capturePerPage", String(config.capturePerPage || DEFAULT_CAPTURE_PER_PAGE));
  url.searchParams.set("captureTotal", String(totalChecks));
  url.searchParams.set("window", config.captureWindow || "90m");
  return url.toString();
}

async function captureScreenshot(config, pageUrl = config.statusPageUrl) {
  await fs.mkdir(config.runtimeDir, { recursive: true });

  const screenshotPath = path.join(
    config.runtimeDir,
    `status-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`
  );

  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--lang=zh-CN",
    "--run-all-compositor-stages-before-draw",
    `--window-size=${config.screenshotWidth},${config.screenshotHeight}`,
    `--virtual-time-budget=${config.screenshotWaitMs}`,
    `--screenshot=${screenshotPath}`,
    pageUrl
  ];

  try {
    await execFileAsync(config.chromiumBin, args, {
      timeout: config.captureTimeoutMs,
      maxBuffer: 512 * 1024
    });
    const image = await fs.readFile(screenshotPath);
    return image.toString("base64");
  } finally {
    fs.unlink(screenshotPath).catch(() => {});
  }
}

function resolveBotIntent(event, trigger = DEFAULT_TRIGGER) {
  if (!event || event.post_type !== "message" || event.message_type !== "group") {
    return { type: "ignore" };
  }

  if (!event.group_id) {
    return { type: "ignore" };
  }

  const text = normalizeCommandText(extractMessageText(event));
  if (text === trigger) {
    return { type: "status" };
  }

  if (isSettingsCommand(text, trigger)) {
    return isGroupAdmin(event) ? { type: "settings" } : { type: "ignore" };
  }

  return { type: "ignore" };
}

function shouldHandleEvent(event, trigger = DEFAULT_TRIGGER) {
  return resolveBotIntent(event, trigger).type === "status";
}

function isSettingsCommand(text, trigger = DEFAULT_TRIGGER) {
  if (!text) return false;
  return [
    `${trigger}设置`,
    `${trigger} 设置`,
    `${trigger}配置`,
    `${trigger} 配置`,
    `${trigger}权限`,
    `${trigger} 权限`,
    `/${trigger}设置`,
    `/${trigger} 设置`,
    `/状态设置`,
    `/状态检查设置`
  ].some((command) => text.startsWith(command));
}

function isGroupAdmin(event) {
  const role = String(event?.sender?.role || event?.role || "").toLowerCase();
  return ADMIN_ROLES.has(role);
}

function normalizeCommandText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMessageText(event) {
  if (typeof event.raw_message === "string") {
    return event.raw_message;
  }

  if (typeof event.message === "string") {
    return event.message;
  }

  if (Array.isArray(event.message)) {
    return event.message
      .filter((segment) => segment && segment.type === "text")
      .map((segment) => segment.data?.text || "")
      .join("");
  }

  return "";
}

function sendGroupText(client, groupId, text) {
  sendGroupMessage(client, groupId, [
    { type: "text", data: { text } }
  ]);
}

function handleSettingsCommand(client, event, config) {
  sendGroupText(
    client,
    event.group_id,
    [
      "状态检查设置：",
      `触发词：${config.trigger}`,
      `截图冷却：${Math.ceil(config.cooldownMs / 1000)} 秒`,
      "权限：普通成员仅可发送完整触发词；设置指令仅群主/管理员可用。"
    ].join("\n")
  );
}

function sendGroupMessage(client, groupId, message) {
  sendAction(client, {
    action: "send_group_msg",
    params: {
      group_id: groupId,
      message
    },
    echo: `status-check-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`
  });
}

function sendAction(client, payload) {
  if (client.socket.destroyed || client.socket.writableEnded) {
    return;
  }
  client.socket.write(encodeTextFrame(JSON.stringify(payload)));
}

function encodeFrame(payload, opcode) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || "");
  let header;

  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = body.length;
  } else if (body.length <= 65535) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }

  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

function closeClient(client, state) {
  if (client.closed) return;
  client.closed = true;
  try {
    client.socket.end(encodeFrame(Buffer.alloc(0), 0x8));
  } catch {
    client.socket.destroy();
  }
  removeClient(client, state);
}

function removeClient(client, state) {
  state.clients.delete(client);
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createConfig,
  startServer,
  buildCapturePageUrl,
  buildScreenshotMessage,
  buildStatusApiUrl,
  createCapturePlan,
  resolveBotIntent,
  shouldHandleEvent,
  isGroupAdmin,
  isSettingsCommand,
  extractMessageText,
  normalizeCommandText,
  parseFrames,
  encodeFrame
};
