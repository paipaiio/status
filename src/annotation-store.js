"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const LEVELS = new Set(["info", "warning", "critical", "success"]);
const STATUSES = new Set(["active", "resolved"]);
const SOURCES = new Set(["admin", "integration"]);

class AnnotationStore {
  constructor(options = {}) {
    this.filePath = options.filePath;
    this.records = readRecords(this.filePath);
  }

  list(options = {}) {
    const includeResolved = Boolean(options.includeResolved);
    return this.records
      .filter((record) => includeResolved || record.status === "active")
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .map(toClientAnnotation);
  }

  listForSnapshot() {
    return this.list({ includeResolved: false });
  }

  create(input, options = {}) {
    const now = new Date().toISOString();
    const record = normalizeAnnotation(input, {
      id: createAnnotationId(),
      now,
      source: options.source || input?.source || "admin"
    });
    this.records.push(record);
    this.save();
    return toClientAnnotation(record);
  }

  resolve(id) {
    const record = this.records.find((item) => item.id === id);
    if (!record) return null;
    record.status = "resolved";
    record.resolvedAt = new Date().toISOString();
    record.updatedAt = record.resolvedAt;
    this.save();
    return toClientAnnotation(record);
  }

  remove(id) {
    const index = this.records.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const [record] = this.records.splice(index, 1);
    this.save();
    return toClientAnnotation(record);
  }

  save() {
    writeRecords(this.filePath, this.records);
  }
}

function readRecords(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];

  let parsed;
  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    parsed = content ? JSON.parse(content) : [];
  } catch (error) {
    throw new Error(`Annotation config must be valid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Annotation config must be a JSON array");
  }

  return parsed.map((item) => normalizeStoredAnnotation(item));
}

function writeRecords(filePath, records) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(records.map(normalizeStoredAnnotation), null, 2)}\n`);
}

function normalizeAnnotation(input, options) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("批注内容必须是对象");
  }

  const title = cleanText(input.title, "标题", 120);
  const body = cleanText(input.body, "内容", 1000);
  const level = lowerChoice(input.level || "info", LEVELS, "级别");
  const status = lowerChoice(input.status || "active", STATUSES, "状态");
  const source = lowerChoice(options.source || input.source || "admin", SOURCES, "来源");
  const targetId = optionalId(input.targetId);

  return {
    id: cleanId(input.id || options.id),
    title,
    body,
    level,
    status,
    targetId,
    source,
    notify: input.notify !== false,
    createdAt: input.createdAt ? String(input.createdAt) : options.now,
    updatedAt: input.updatedAt ? String(input.updatedAt) : options.now,
    resolvedAt: input.resolvedAt ? String(input.resolvedAt) : null
  };
}

function normalizeStoredAnnotation(input) {
  return normalizeAnnotation(input, {
    id: input?.id || createAnnotationId(),
    now: new Date().toISOString(),
    source: input?.source || "admin"
  });
}

function toClientAnnotation(record) {
  return {
    id: record.id,
    title: record.title,
    body: record.body,
    level: record.level,
    status: record.status,
    targetId: record.targetId || null,
    source: record.source,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    resolvedAt: record.resolvedAt || null,
    notify: record.notify
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
  if (!/^[a-z0-9][a-z0-9-_.]{0,79}$/i.test(id)) {
    throw new Error("批注 ID 不合法");
  }
  return id;
}

function optionalId(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (!/^[a-z0-9][a-z0-9-_.]{0,79}$/i.test(text)) {
    throw new Error("关联检测项 ID 不合法");
  }
  return text;
}

function lowerChoice(value, allowed, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!allowed.has(normalized)) {
    throw new Error(`${label}不支持`);
  }
  return normalized;
}

function createAnnotationId() {
  return `note-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

module.exports = {
  AnnotationStore,
  createAnnotationId,
  toClientAnnotation
};
