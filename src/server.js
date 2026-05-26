"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { AnnotationStore } = require("./annotation-store");
const { createAdminAuth } = require("./admin-auth");
const { getRuntimeConfig } = require("./config");
const { HealthMonitor } = require("./checker");
const { JsonHistoryStore } = require("./history-store");
const { WebhookNotifier } = require("./notifier");
const { ManagedTargetStore } = require("./target-store");
const { WebSocketHub } = require("./socket");

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"]
]);

let config;
try {
  config = getRuntimeConfig();
} catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}

const managedTargetsFile = path.resolve(
  config.rootDir,
  process.env.MANAGED_TARGETS_FILE || "config/targets.json"
);
let targetStore;
let managedTargets;
try {
  targetStore = new ManagedTargetStore({ filePath: managedTargetsFile });
  managedTargets = targetStore.buildTargets(config.targets.length);
} catch (error) {
  console.error(`Managed target configuration error: ${error.message}`);
  process.exit(1);
}
config = {
  ...config,
  adminUsername: process.env.ADMIN_USERNAME || "root",
  adminPassword: process.env.ADMIN_PASSWORD || "Admin@123",
  managedTargetsFile,
  targets: assertUniqueTargets([...config.targets, ...managedTargets])
};

const adminAuth = createAdminAuth({
  username: config.adminUsername,
  password: config.adminPassword,
  ttlMs: numberFromEnv("ADMIN_SESSION_TTL_HOURS", 24, { min: 1, max: 720 }) * 60 * 60 * 1000
});

let monitor;
let historyStore;
let annotationStore;
let notifier;
try {
  historyStore = new JsonHistoryStore({
    filePath: path.resolve(config.rootDir, process.env.STATUS_HISTORY_FILE || "runtime/status-history.json"),
    maxRecordsPerTarget: numberFromEnv("STATUS_HISTORY_LIMIT", 50000, { min: 100, max: 500000 }),
    retentionMs: numberFromEnv("STATUS_HISTORY_RETENTION_DAYS", 30, { min: 1, max: 365 }) * 24 * 60 * 60 * 1000
  });
  annotationStore = new AnnotationStore({
    filePath: path.resolve(config.rootDir, process.env.ANNOTATIONS_FILE || "runtime/annotations.json")
  });
  notifier = new WebhookNotifier({
    urls: process.env.NOTIFICATION_WEBHOOK_URLS || "",
    token: process.env.NOTIFICATION_WEBHOOK_TOKEN || "",
    timeoutMs: numberFromEnv("NOTIFICATION_TIMEOUT_MS", 5000, { min: 1000, max: 30000 })
  });
} catch (error) {
  console.error(`Runtime store configuration error: ${error.message}`);
  process.exit(1);
}

const socketHub = new WebSocketHub({
  getSnapshot: () => buildClientSnapshot()
});

monitor = new HealthMonitor(config.targets, {
  historyLimit: numberFromEnv("STATUS_HISTORY_LIMIT", 50000, { min: 100, max: 500000 }),
  historyRetentionMs: numberFromEnv("STATUS_HISTORY_RETENTION_DAYS", 30, { min: 1, max: 365 }) * 24 * 60 * 60 * 1000,
  historyStore,
  onUpdate: ({ event, targetId }) => socketHub.broadcastSnapshot(event, targetId)
});
monitor.start();

const server = http.createServer(async (req, res) => {
  try {
    applySecurityHeaders(res);
    applyCorsHeaders(req, res, config.frontendOrigin);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        targetCount: config.targets.length,
        generatedAt: new Date().toISOString()
      });
      return;
    }

    if (url.pathname === "/api/config" && req.method === "GET") {
      sendJson(res, 200, {
        adminEnabled: true,
        manualCheckEnabled: Boolean(config.manualCheckToken),
        realtimeEnabled: true,
        socketPath: "/socket"
      });
      return;
    }

    if (url.pathname === "/api/status" && req.method === "GET") {
      sendJson(res, 200, buildClientSnapshot());
      return;
    }

    if (url.pathname === "/api/integrations/annotations" && req.method === "POST") {
      if (!isIntegrationAuthorized(req)) {
        sendJson(res, 401, { error: "Integration token is missing or invalid" });
        return;
      }

      try {
        const annotation = await createAnnotationFromRequest(req, { source: "integration" });
        sendJson(res, 201, {
          annotation,
          notificationsEnabled: notifier.enabled
        });
      } catch (error) {
        sendJson(res, 400, { error: error.message || "批注内容无效" });
      }
      return;
    }

    if (url.pathname === "/api/check" && req.method === "POST") {
      if (!isAuthorized(req, config.manualCheckToken)) {
        sendJson(res, 403, { error: "Manual check is not enabled or token is invalid" });
        return;
      }

      const targetId = url.searchParams.get("target");
      if (targetId) {
        await monitor.runCheck(targetId);
        sendJson(res, 200, monitor.getSnapshot());
        return;
      }

      await monitor.runAllChecks();
      sendJson(res, 200, monitor.getSnapshot());
      return;
    }

    if (url.pathname === "/api/admin/login" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!adminAuth.verifyCredentials(body)) {
        sendJson(res, 401, { error: "用户名或密码不正确" });
        return;
      }

      const session = adminAuth.createSession();
      adminAuth.setSessionCookie(req, res, session);
      sendJson(res, 200, {
        authenticated: true,
        username: session.username,
        expiresAt: new Date(session.expiresAt).toISOString()
      });
      return;
    }

    if (url.pathname === "/api/admin/logout" && req.method === "POST") {
      adminAuth.destroySession(req);
      adminAuth.clearSessionCookie(req, res);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/admin/session" && req.method === "GET") {
      const session = adminAuth.getSession(req);
      sendJson(res, 200, {
        authenticated: Boolean(session),
        username: session?.username || null
      });
      return;
    }

    if (url.pathname === "/api/admin/targets" && req.method === "GET") {
      if (!requireAdmin(req, res)) return;

      sendJson(res, 200, {
        targets: targetStore.listSafe(),
        runtimeTargets: buildClientSnapshot().checks
      });
      return;
    }

    if (url.pathname === "/api/admin/annotations" && req.method === "GET") {
      if (!requireAdmin(req, res)) return;

      sendJson(res, 200, {
        annotations: annotationStore.list({ includeResolved: url.searchParams.get("includeResolved") === "1" }),
        targets: buildClientSnapshot().checks.map((check) => ({ id: check.id, name: check.name }))
      });
      return;
    }

    if (url.pathname === "/api/admin/annotations" && req.method === "POST") {
      if (!requireAdmin(req, res)) return;

      try {
        const annotation = await createAnnotationFromRequest(req, { source: "admin" });
        sendJson(res, 201, { annotation });
      } catch (error) {
        sendJson(res, 400, { error: error.message || "批注内容无效" });
      }
      return;
    }

    const annotationResolveMatch = url.pathname.match(/^\/api\/admin\/annotations\/([A-Za-z0-9._-]+)\/resolve$/);
    if (annotationResolveMatch && req.method === "PATCH") {
      if (!requireAdmin(req, res)) return;

      const annotation = annotationStore.resolve(annotationResolveMatch[1]);
      if (!annotation) {
        sendJson(res, 404, { error: "批注不存在" });
        return;
      }

      socketHub.broadcastSnapshot("annotation-resolved", annotation.targetId || null);
      sendJson(res, 200, { annotation });
      return;
    }

    const annotationDeleteMatch = url.pathname.match(/^\/api\/admin\/annotations\/([A-Za-z0-9._-]+)$/);
    if (annotationDeleteMatch && req.method === "DELETE") {
      if (!requireAdmin(req, res)) return;

      const annotation = annotationStore.remove(annotationDeleteMatch[1]);
      if (!annotation) {
        sendJson(res, 404, { error: "批注不存在" });
        return;
      }

      socketHub.broadcastSnapshot("annotation-deleted", annotation.targetId || null);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/admin/notifications/test" && req.method === "POST") {
      if (!requireAdmin(req, res)) return;

      const testAnnotation = {
        id: "notification-test",
        title: "通知通道测试",
        body: "这是一条来自状态检查后台的测试通知。",
        level: "info",
        status: "active",
        targetId: null,
        source: "admin",
        createdAt: new Date().toISOString()
      };
      const results = await notifier.notifyAnnotation(testAnnotation, {
        summary: buildClientSnapshot().summary
      });
      sendJson(res, 200, {
        enabled: notifier.enabled,
        results
      });
      return;
    }

    if (url.pathname === "/api/admin/targets" && req.method === "POST") {
      if (!requireAdmin(req, res)) return;

      try {
        const body = await readJsonBody(req);
        const existingIds = new Set(monitor.targets.map((target) => target.id));
        const created = targetStore.create(body, existingIds, monitor.targets.length);
        monitor.addTarget(created.target);
        sendJson(res, 201, {
          target: targetStore.listSafe().find((target) => target.id === created.record.id),
          snapshot: buildClientSnapshot()
        });
      } catch (error) {
        sendJson(res, 400, { error: error.message || "检测模型配置无效" });
      }
      return;
    }

    const adminTargetMatch = url.pathname.match(/^\/api\/admin\/targets\/([A-Za-z0-9._-]+)$/);
    if (adminTargetMatch && req.method === "DELETE") {
      if (!requireAdmin(req, res)) return;

      const targetId = adminTargetMatch[1];
      const removed = targetStore.remove(targetId);
      if (!removed) {
        sendJson(res, 404, { error: "动态检测模型不存在" });
        return;
      }

      monitor.removeTarget(targetId);
      sendJson(res, 200, {
        ok: true,
        snapshot: buildClientSnapshot()
      });
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(url.pathname, req, res, config.rootDir);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    const status = error.statusCode || (error.message === "Unknown target" ? 404 : 500);
    const publicMessage = status === 404
      ? "Target not found"
      : status < 500
        ? error.message
        : "Internal server error";
    sendJson(res, status, { error: publicMessage });
  }
});

server.on("upgrade", (req, socket) => {
  socketHub.handleUpgrade(req, socket);
});

server.on("error", (error) => {
  console.error(`Server error: ${error.message}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(`API status site running at http://${config.host}:${config.port}`);
  console.log(`Loaded ${config.targets.length} target(s)`);
});

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'self'"
  );
}

function applyCorsHeaders(req, res, frontendOrigin) {
  const origin = req.headers.origin;
  if (!origin || !frontendOrigin) return;

  const allowedOrigins = frontendOrigin.split(",").map((item) => item.trim()).filter(Boolean);
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Admin-Token,X-Integration-Token,X-Annotation-Token,Authorization");
  }
}

function isAuthorized(req, token) {
  if (!token) return false;
  return req.headers["x-admin-token"] === token;
}

function requireAdmin(req, res) {
  if (adminAuth.getSession(req)) return true;
  sendJson(res, 401, { error: "请先登录后台" });
  return false;
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("请求体过大");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (_error) {
    const error = new Error("请求体必须是 JSON");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function buildClientSnapshot() {
  const snapshot = monitor.getSnapshot();
  const manualAnnotations = annotationStore.listForSnapshot().map((annotation) => {
    const target = annotation.targetId
      ? monitor.targets.find((item) => item.id === annotation.targetId)
      : null;
    return {
      id: annotation.id,
      targetName: target?.name || annotation.targetId || "全局批注",
      targetId: annotation.targetId,
      level: annotation.level,
      status: annotation.status,
      title: annotation.title,
      body: annotation.body,
      source: annotation.source,
      createdAt: annotation.createdAt
    };
  });

  const checks = snapshot.checks.map((check) => {
    const manual = highestPriorityAnnotation(manualAnnotations.filter((annotation) => annotation.targetId === check.id));
    return {
      ...check,
      annotation: manual || check.annotation
    };
  });

  return {
    ...snapshot,
    checks,
    annotations: [...manualAnnotations, ...(snapshot.annotations || [])],
    adminEnabled: true,
    manualCheckEnabled: Boolean(config.manualCheckToken),
    realtimeEnabled: true,
    socketPath: "/socket"
  };
}

async function createAnnotationFromRequest(req, options = {}) {
  const body = await readJsonBody(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("批注内容必须是对象");
  }
  assertKnownTarget(body.targetId);
  const annotation = annotationStore.create(body, { source: options.source || "admin" });
  socketHub.broadcastSnapshot("annotation-created", annotation.targetId || null);

  if (annotation.notify) {
    notifier.notifyAnnotation(annotation, {
      summary: buildClientSnapshot().summary
    }).catch((error) => {
      console.error(`Notification error: ${error.message}`);
    });
  }

  return annotation;
}

function assertKnownTarget(targetId) {
  if (!targetId) return;
  if (!monitor.targets.some((target) => target.id === targetId)) {
    throw new Error("关联检测项不存在");
  }
}

function highestPriorityAnnotation(annotations) {
  const priority = { critical: 4, warning: 3, info: 2, success: 1 };
  return annotations
    .slice()
    .sort((left, right) => {
      const priorityDiff = (priority[right.level] || 0) - (priority[left.level] || 0);
      if (priorityDiff) return priorityDiff;
      return Date.parse(right.createdAt || "") - Date.parse(left.createdAt || "");
    })[0] || null;
}

function isIntegrationAuthorized(req) {
  const token = process.env.ANNOTATION_API_TOKEN || "";
  if (!token) return false;
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  return req.headers["x-annotation-token"] === token ||
    req.headers["x-integration-token"] === token ||
    bearer === token;
}

function serveStatic(pathname, req, res, rootDir) {
  const frontendDir = path.join(rootDir, "frontend");
  const relativePath = pathname === "/"
    ? "index.html"
    : pathname === "/admin" || pathname === "/admin/"
      ? "admin.html"
      : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(frontendDir, relativePath);
  const relativeToFrontend = path.relative(frontendDir, resolved);

  if (relativeToFrontend.startsWith("..") || path.isAbsolute(relativeToFrontend)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": MIME_TYPES.get(path.extname(resolved)) || "application/octet-stream",
    "Cache-Control": ["/", "/admin", "/admin/"].includes(pathname) ? "no-store" : "public, max-age=60"
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  fs.createReadStream(resolved).pipe(res);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  monitor.stop();
  socketHub.close();
  server.close(() => process.exit(0));
}

function assertUniqueTargets(targets) {
  const ids = new Set();
  for (const target of targets) {
    if (ids.has(target.id)) {
      throw new Error(`Duplicate target id: ${target.id}`);
    }
    ids.add(target.id);
  }
  return targets;
}

function numberFromEnv(name, fallback, options = {}) {
  const raw = process.env[name];
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) return fallback;

  if (options.min !== undefined && value < options.min) return fallback;
  if (options.max !== undefined && value > options.max) return fallback;

  return value;
}
