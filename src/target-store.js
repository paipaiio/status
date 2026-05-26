"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { createApiRelayTarget } = require("./config");

const FORMATS = new Set(["auto", "openai", "anthropic"]);
const CHECK_MODES = new Set(["auto", "models", "chat"]);

class ManagedTargetStore {
  constructor(options) {
    this.filePath = options.filePath;
    this.records = readRecords(this.filePath);
  }

  buildTargets(startIndex = 0) {
    return this.records.map((record, index) => createApiRelayTarget(record, startIndex + index));
  }

  listSafe() {
    return this.records.map(toSafeRecord);
  }

  create(input, existingIds, targetIndex) {
    const record = createRecord(input, existingIds);
    const target = createApiRelayTarget(record, targetIndex);
    this.records.push(record);
    this.save();
    return { record, target };
  }

  remove(id) {
    const index = this.records.findIndex((record) => record.id === id);
    if (index === -1) return null;

    const [record] = this.records.splice(index, 1);
    this.save();
    return record;
  }

  save() {
    writeRecords(this.filePath, this.records);
  }
}

function readRecords(filePath) {
  if (!fs.existsSync(filePath)) return [];

  let parsed;
  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    parsed = content ? JSON.parse(content) : [];
  } catch (error) {
    throw new Error(`Managed target config must be valid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Managed target config must be a JSON array");
  }

  return parsed.map((item) => normalizeRecord(item, { stored: true }));
}

function writeRecords(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(records.map((item) => normalizeRecord(item, { stored: true })), null, 2)}\n`);
}

function createRecord(input, existingIds) {
  const now = new Date().toISOString();
  const record = normalizeRecord(input, {
    id: createRecordId(existingIds),
    stored: false
  });

  return {
    ...record,
    createdAt: now,
    updatedAt: now,
    source: "admin"
  };
}

function normalizeRecord(input, options) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("检测模型配置必须是对象");
  }

  const format = lowerChoice(input.format || "auto", FORMATS, "FORMAT");
  const checkMode = lowerChoice(input.checkMode || "auto", CHECK_MODES, "CHECK_MODE");
  const record = {
    id: cleanId(input.id || options.id),
    name: cleanText(input.name || input.model || "API 中转站", "名称", 80),
    group: cleanText(input.group || "API 中转站", "分组", 80),
    baseUrl: cleanText(input.baseUrl, "Base URL", 2048),
    model: cleanText(input.model, "模型", 180),
    apiKey: cleanText(input.apiKey, "API Key", 4096),
    format,
    checkMode,
    source: input.source === "admin" ? "admin" : undefined,
    createdAt: input.createdAt ? String(input.createdAt) : undefined,
    updatedAt: input.updatedAt ? String(input.updatedAt) : undefined
  };

  const timeoutMs = boundedNumber(input.timeoutMs, 1000, 120000);
  const intervalSeconds = boundedNumber(input.intervalSeconds, 5, 86400);
  const allowedLatencyMs = boundedNumber(input.allowedLatencyMs, 100, 600000);
  if (timeoutMs) record.timeoutMs = timeoutMs;
  if (intervalSeconds) record.intervalSeconds = intervalSeconds;
  if (allowedLatencyMs) record.allowedLatencyMs = allowedLatencyMs;

  if (!options.stored) {
    delete record.createdAt;
    delete record.updatedAt;
    delete record.source;
  }

  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function toSafeRecord(record) {
  return {
    id: record.id,
    name: record.name,
    group: record.group,
    baseUrl: record.baseUrl,
    model: record.model,
    format: record.format,
    checkMode: record.checkMode,
    timeoutMs: record.timeoutMs || null,
    intervalSeconds: record.intervalSeconds || null,
    allowedLatencyMs: record.allowedLatencyMs || null,
    hasApiKey: Boolean(record.apiKey),
    apiKeyMask: maskSecret(record.apiKey),
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null
  };
}

function cleanText(value, label, maxLength) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (text.length > maxLength) throw new Error(`${label}过长`);
  return text;
}

function cleanId(value) {
  const id = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9-_.]{0,63}$/i.test(id)) {
    throw new Error("检测模型 ID 不合法");
  }
  return id;
}

function lowerChoice(value, allowed, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!allowed.has(normalized)) {
    throw new Error(`${label} 不支持`);
  }
  return normalized;
}

function boundedNumber(value, min, max) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`数字参数必须在 ${min} 到 ${max} 之间`);
  }
  return number;
}

function createRecordId(existingIds) {
  let id;
  do {
    id = `custom-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  } while (existingIds.has(id));
  return id;
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "********";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

module.exports = {
  ManagedTargetStore,
  createRecord,
  maskSecret,
  readRecords,
  toSafeRecord
};
