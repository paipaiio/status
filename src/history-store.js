"use strict";

const fs = require("node:fs");
const path = require("node:path");

class JsonHistoryStore {
  constructor(options = {}) {
    this.filePath = options.filePath;
    this.retentionMs = options.retentionMs || 30 * 24 * 60 * 60 * 1000;
    this.maxRecordsPerTarget = options.maxRecordsPerTarget || 50000;
    this.data = this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return {};

    let parsed;
    try {
      const content = fs.readFileSync(this.filePath, "utf8").trim();
      parsed = content ? JSON.parse(content) : {};
    } catch (error) {
      throw new Error(`Status history must be valid JSON: ${error.message}`);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Status history must be a JSON object");
    }

    return Object.fromEntries(
      Object.entries(parsed).map(([targetId, records]) => [
        targetId,
        this.pruneRecords(Array.isArray(records) ? records : [])
      ])
    );
  }

  append(targetId, record) {
    if (!targetId || !record) return;
    const records = this.data[targetId] || [];
    records.push(normalizeRecord(record));
    this.data[targetId] = this.pruneRecords(records);
    this.save();
  }

  pruneRecords(records) {
    const cutoff = Date.now() - this.retentionMs;
    const normalized = records
      .map(normalizeRecord)
      .filter((record) => {
        const timestamp = Date.parse(record.at);
        return Number.isFinite(timestamp) && timestamp >= cutoff;
      });

    if (normalized.length > this.maxRecordsPerTarget) {
      normalized.splice(0, normalized.length - this.maxRecordsPerTarget);
    }

    return normalized;
  }

  save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}

function normalizeRecord(record) {
  return {
    at: String(record.at || new Date().toISOString()),
    status: String(record.status || "pending"),
    latencyMs: record.latencyMs === null || record.latencyMs === undefined ? null : Number(record.latencyMs),
    statusCode: record.statusCode === null || record.statusCode === undefined ? null : Number(record.statusCode)
  };
}

module.exports = {
  JsonHistoryStore,
  normalizeRecord
};
