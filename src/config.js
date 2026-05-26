"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");

function parseDotEnvContent(content) {
  const values = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function loadEnvFile(filePath = path.join(ROOT_DIR, ".env")) {
  if (!fs.existsSync(filePath)) return {};

  const parsed = parseDotEnvContent(fs.readFileSync(filePath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return parsed;
}

function numberFromEnv(name, fallback, options = {}) {
  const raw = process.env[name];
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) return fallback;

  if (options.min !== undefined && value < options.min) return fallback;
  if (options.max !== undefined && value > options.max) return fallback;

  return value;
}

function expandEnvTokens(value, env = process.env) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key) => {
      return env[key] ?? "";
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => expandEnvTokens(item, env));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandEnvTokens(item, env)])
    );
  }

  return value;
}

function readTargetsSource() {
  if (process.env.API_TARGETS) {
    return process.env.API_TARGETS;
  }

  if (process.env.API_TARGETS_FILE) {
    const targetFile = path.resolve(ROOT_DIR, process.env.API_TARGETS_FILE);
    if (!fs.existsSync(targetFile)) {
      throw new Error(`API_TARGETS_FILE not found: ${process.env.API_TARGETS_FILE}`);
    }
    return fs.readFileSync(targetFile, "utf8");
  }

  return "[]";
}

function discoverEnvTargets(env = process.env) {
  const groups = new Map();

  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^API_(\d+)_(.+)$/);
    if (!match) continue;

    const [, index, rawField] = match;
    const field = normalizeEnvField(rawField);
    if (!field) continue;

    if (!groups.has(index)) groups.set(index, {});
    groups.get(index)[field] = value;
  }

  if (groups.size === 0) {
    const single = readSingleEnvTarget(env);
    if (single) groups.set("1", single);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, group], index) => createApiRelayTarget(group, index));
}

function normalizeEnvField(rawField) {
  const field = rawField.replace(/_/g, "").toUpperCase();
  const aliases = {
    ALLOWEDLATENCYMS: "allowedLatencyMs",
    APIKEY: "apiKey",
    BASEURL: "baseUrl",
    CHECKMODE: "checkMode",
    FORMAT: "format",
    GROUP: "group",
    INTERVALSECONDS: "intervalSeconds",
    MODEL: "model",
    NAME: "name",
    PROVIDER: "format",
    TIMEOUTMS: "timeoutMs"
  };

  return aliases[field] || null;
}

function readSingleEnvTarget(env) {
  const baseUrl = env.API_BASE_URL || env.BASE_URL;
  const model = env.API_MODEL || env.MODEL;
  const apiKey = env.API_API_KEY || env.APIKEY || env.API_KEY;
  if (!baseUrl && !model && !apiKey) return null;

  return {
    allowedLatencyMs: env.API_ALLOWED_LATENCY_MS,
    apiKey,
    baseUrl,
    checkMode: env.API_CHECK_MODE,
    format: env.API_FORMAT || env.API_PROVIDER,
    group: env.API_GROUP,
    intervalSeconds: env.API_INTERVAL_SECONDS,
    model,
    name: env.API_NAME,
    timeoutMs: env.API_TIMEOUT_MS
  };
}

function createApiRelayTarget(group, index) {
  const label = group.name || `API 中转站 ${index + 1}`;
  if (!group.baseUrl) throw new Error(`${label} is missing BASE_URL`);
  if (!group.model) throw new Error(`${label} is missing MODEL`);
  if (!group.apiKey) throw new Error(`${label} is missing API_KEY`);

  const format = String(group.format || "auto").toLowerCase();
  if (!["auto", "openai", "anthropic"].includes(format)) {
    throw new Error(`${label} FORMAT must be "auto", "openai", or "anthropic"`);
  }

  const checkMode = String(group.checkMode || "auto").toLowerCase();
  if (!["auto", "models", "chat"].includes(checkMode)) {
    throw new Error(`${label} CHECK_MODE must be "auto", "models", or "chat"`);
  }

  const baseUrl = normalizeBaseUrl(group.baseUrl);
  const attempts = buildProbeAttempts({
    apiKey: group.apiKey,
    baseUrl,
    checkMode,
    format,
    model: group.model
  });
  const primaryAttempt = attempts[0];

  return normalizeTarget(
    {
      id: group.id || `api-${index + 1}`,
      name: label,
      group: group.group || "API 中转站",
      description: describeProbe(format, checkMode),
      format,
      model: group.model,
      checkMode,
      url: primaryAttempt.url,
      method: primaryAttempt.method,
      headers: primaryAttempt.headers,
      body: primaryAttempt.body,
      attempts,
      expectedStatus: [200],
      timeoutMs: group.timeoutMs,
      intervalSeconds: group.intervalSeconds,
      allowedLatencyMs: group.allowedLatencyMs
    },
    index,
    {}
  );
}

function createOpenAiCompatibleTarget(group, index) {
  return createApiRelayTarget({ ...group, format: "openai" }, index);
}

function buildProbeAttempts({ apiKey, baseUrl, checkMode, format, model }) {
  const formats = format === "auto" ? ["openai", "anthropic"] : [format];
  const phases = checkMode === "auto" ? ["models", "chat"] : [checkMode];
  const attempts = [];

  for (const phase of phases) {
    for (const targetFormat of formats) {
      attempts.push(createProbeAttempt({ apiKey, baseUrl, format: targetFormat, model, phase }));
    }
  }

  return attempts;
}

function createProbeAttempt({ apiKey, baseUrl, format, model, phase }) {
  if (format === "anthropic") {
    const isModelsCheck = phase === "models";
    return {
      format,
      checkType: isModelsCheck ? "models" : "chat",
      url: buildOpenAiCompatibleUrl(baseUrl, isModelsCheck ? "models" : "messages"),
      method: isModelsCheck ? "GET" : "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        ...(isModelsCheck ? {} : { "Content-Type": "application/json" })
      },
      body: isModelsCheck
        ? undefined
        : JSON.stringify({
            model,
            messages: [{ role: "user", content: "." }],
            max_tokens: 1
          }),
      expectedStatus: [200]
    };
  }

  const isModelsCheck = phase === "models";
  return {
    format,
    checkType: isModelsCheck ? "models" : "chat",
    url: buildOpenAiCompatibleUrl(baseUrl, isModelsCheck ? "models" : "chat/completions"),
    method: isModelsCheck ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(isModelsCheck ? {} : { "Content-Type": "application/json" })
    },
    body: isModelsCheck
      ? undefined
      : JSON.stringify({
          model,
          messages: [{ role: "user", content: "." }],
          max_tokens: 1,
          temperature: 0,
          stream: false
        }),
    expectedStatus: [200]
  };
}

function describeProbe(format, checkMode) {
  if (checkMode === "models") return "模型列表探测（不生成内容）";
  if (checkMode === "chat") return "最小 token 实测";
  if (format === "auto") return "自动格式探测（先查模型列表）";
  return "自动探测（先查模型列表）";
}

function normalizeBaseUrl(value) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = new URL(withProtocol);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function buildOpenAiCompatibleUrl(baseUrl, endpoint) {
  const parsed = new URL(baseUrl);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  const nextPath = pathname.endsWith("/v1")
    ? `${pathname}/${endpoint}`
    : `${pathname}/v1/${endpoint}`;
  parsed.pathname = nextPath.replace(/\/{2,}/g, "/");
  return parsed.toString();
}

function parseTargets(source, env = process.env) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`API target config must be valid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("API target config must be a JSON array");
  }

  return parsed.map((target, index) => normalizeTarget(target, index, env));
}

function normalizeTarget(target, index, env) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error(`Target at index ${index} must be an object`);
  }

  const expanded = expandEnvTokens(target, env);
  const id = String(expanded.id || `target-${index + 1}`).trim();
  const name = String(expanded.name || id).trim();
  const method = String(expanded.method || "GET").trim().toUpperCase();
  const url = String(expanded.url || "").trim();

  if (!/^[a-z0-9][a-z0-9-_.]{0,63}$/i.test(id)) {
    throw new Error(`Target "${name}" has an invalid id`);
  }

  if (!url) {
    throw new Error(`Target "${name}" is missing url`);
  }

  const parsedUrl = new URL(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error(`Target "${name}" must use http or https`);
  }

  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) {
    throw new Error(`Target "${name}" uses unsupported method "${method}"`);
  }

  const expectedStatus = normalizeExpectedStatus(expanded.expectedStatus);
  const headers = normalizeHeaders(expanded.headers, name);
  const timeoutMs = positiveNumber(expanded.timeoutMs, numberFromEnv("REQUEST_TIMEOUT_MS", 12000, { min: 1000 }));
  const intervalSeconds = positiveNumber(
    expanded.intervalSeconds,
    numberFromEnv("CHECK_INTERVAL_SECONDS", 60, { min: 5 })
  );
  const allowedLatencyMs = positiveNumber(expanded.allowedLatencyMs, 3000);
  const body = normalizeBody(expanded.body, headers);

  return {
    id,
    name,
    group: expanded.group ? String(expanded.group) : "默认分组",
    description: expanded.description ? String(expanded.description) : "",
    format: expanded.format ? String(expanded.format) : "",
    model: expanded.model ? String(expanded.model) : "",
    checkMode: expanded.checkMode ? String(expanded.checkMode) : "",
    method,
    url,
    headers,
    body,
    expectedStatus,
    timeoutMs,
    intervalMs: intervalSeconds * 1000,
    allowedLatencyMs,
    attempts: normalizeAttempts(expanded.attempts, name)
  };
}

function normalizeAttempts(attempts, targetName) {
  if (!attempts) return [];
  if (!Array.isArray(attempts)) {
    throw new Error(`Target "${targetName}" attempts must be an array`);
  }

  return attempts.map((attempt, index) => normalizeAttempt(attempt, targetName, index));
}

function normalizeAttempt(attempt, targetName, index) {
  if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) {
    throw new Error(`Target "${targetName}" attempt ${index + 1} must be an object`);
  }

  const method = String(attempt.method || "GET").trim().toUpperCase();
  const url = String(attempt.url || "").trim();
  if (!url) throw new Error(`Target "${targetName}" attempt ${index + 1} is missing url`);

  const parsedUrl = new URL(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error(`Target "${targetName}" attempt ${index + 1} must use http or https`);
  }

  const headers = normalizeHeaders(attempt.headers, `${targetName} attempt ${index + 1}`);

  return {
    format: attempt.format ? String(attempt.format) : "",
    checkType: attempt.checkType ? String(attempt.checkType) : "",
    method,
    url,
    headers,
    body: normalizeBody(attempt.body, headers),
    expectedStatus: normalizeExpectedStatus(attempt.expectedStatus) || new Set([200])
  };
}

function normalizeExpectedStatus(value) {
  if (value === undefined) return null;

  const statuses = Array.isArray(value) ? value : [value];
  const normalized = statuses.map(Number);
  if (normalized.some((status) => !Number.isInteger(status) || status < 100 || status > 599)) {
    throw new Error("expectedStatus must contain HTTP status codes between 100 and 599");
  }

  return new Set(normalized);
}

function normalizeHeaders(headers, targetName) {
  if (headers === undefined) return {};
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error(`Target "${targetName}" headers must be an object`);
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key), String(value)])
  );
}

function normalizeBody(body, headers) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;

  const headerNames = Object.keys(headers).map((key) => key.toLowerCase());
  if (!headerNames.includes("content-type")) {
    headers["Content-Type"] = "application/json";
  }

  return JSON.stringify(body);
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getRuntimeConfig() {
  loadEnvFile();

  const envTargets = discoverEnvTargets();
  const targets = envTargets.length > 0 ? envTargets : parseTargets(readTargetsSource());
  const ids = new Set();
  for (const target of targets) {
    if (ids.has(target.id)) {
      throw new Error(`Duplicate target id: ${target.id}`);
    }
    ids.add(target.id);
  }

  return {
    rootDir: ROOT_DIR,
    host: process.env.HOST || "127.0.0.1",
    port: numberFromEnv("PORT", 3010, { min: 1, max: 65535 }),
    frontendOrigin: process.env.FRONTEND_ORIGIN || "",
    historyLimit: numberFromEnv("HISTORY_LIMIT", 24, { min: 1, max: 500 }),
    manualCheckToken: process.env.MANUAL_CHECK_TOKEN || "",
    targets
  };
}

module.exports = {
  ROOT_DIR,
  buildOpenAiCompatibleUrl,
  buildProbeAttempts,
  createApiRelayTarget,
  createOpenAiCompatibleTarget,
  discoverEnvTargets,
  expandEnvTokens,
  getRuntimeConfig,
  loadEnvFile,
  normalizeTarget,
  parseDotEnvContent,
  parseTargets
};
