"use strict";

const AVAILABILITY_WINDOWS = [
  { key: "90m", label: "90 分钟", ms: 90 * 60 * 1000, buckets: 30 },
  { key: "24h", label: "24 小时", ms: 24 * 60 * 60 * 1000, buckets: 48 },
  { key: "7d", label: "7 天", ms: 7 * 24 * 60 * 60 * 1000, buckets: 56 },
  { key: "30d", label: "30 天", ms: 30 * 24 * 60 * 60 * 1000, buckets: 60 }
];

class HealthMonitor {
  constructor(targets, options = {}) {
    this.targets = targets;
    this.historyLimit = options.historyLimit || 50000;
    this.historyRetentionMs = options.historyRetentionMs || 30 * 24 * 60 * 60 * 1000;
    this.historyStore = options.historyStore || null;
    this.onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : () => {};
    this.onResult = typeof options.onResult === "function" ? options.onResult : () => {};
    const storedHistory = this.historyStore?.load?.() || {};
    this.states = new Map(
      targets.map((target) => [
        target.id,
        createInitialState(target, pruneHistory(storedHistory[target.id] || [], {
          limit: this.historyLimit,
          retentionMs: this.historyRetentionMs
        }))
      ])
    );
    this.timers = new Map();
    this.startedAt = new Date();
  }

  start() {
    for (const target of this.targets) {
      this.startTarget(target);
    }
  }

  stop() {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  async runCheck(targetId) {
    const target = this.targets.find((item) => item.id === targetId);
    if (!target) {
      throw new Error("Unknown target");
    }

    const state = this.states.get(target.id);
    if (!state || state.removed) {
      throw new Error("Unknown target");
    }
    if (state.inFlight) return state.inFlight;

    state.previousStatus = state.status;
    state.status = "checking";
    state.message = "正在探测";
    this.emitUpdate("checking", target.id);
    state.inFlight = this.performCheck(target, state)
      .catch((error) => {
        this.recordFailure(target, state, "error", safeNetworkMessage(error));
      })
      .finally(() => {
        state.inFlight = null;
      });

    return state.inFlight;
  }

  emitUpdate(event, targetId) {
    this.onUpdate({
      event,
      targetId,
      snapshot: this.getSnapshot()
    });
  }

  async runAllChecks() {
    await Promise.allSettled(this.targets.map((target) => this.runCheck(target.id)));
    return this.getSnapshot();
  }

  addTarget(target) {
    if (this.states.has(target.id) || this.targets.some((item) => item.id === target.id)) {
      throw new Error("Duplicate target");
    }

    this.targets.push(target);
    this.states.set(target.id, createInitialState(target));
    this.startTarget(target);
    this.emitUpdate("target-added", target.id);
  }

  removeTarget(targetId) {
    const index = this.targets.findIndex((target) => target.id === targetId);
    if (index === -1) return false;

    const timer = this.timers.get(targetId);
    if (timer) clearInterval(timer);
    this.timers.delete(targetId);

    const state = this.states.get(targetId);
    if (state) state.removed = true;
    this.states.delete(targetId);
    this.targets.splice(index, 1);
    this.emitUpdate("target-removed", targetId);
    return true;
  }

  startTarget(target) {
    this.runCheck(target.id);
    const timer = setInterval(() => {
      this.runCheck(target.id).catch(() => {});
    }, target.intervalMs);
    timer.unref?.();
    this.timers.set(target.id, timer);
  }

  async performCheck(target, state) {
    const attempts = target.attempts?.length ? target.attempts : [target];
    let lastFailure = null;

    for (const attempt of attempts) {
      const result = await runProbeAttempt(target, attempt);
      if (!result.ok) {
        lastFailure = result;
        continue;
      }

      const status = result.status || (result.latencyMs > target.allowedLatencyMs ? "degraded" : "up");
      const defaultMessage = status === "degraded" ? "响应偏慢" : "响应正常";
      this.recordResult(target, state, {
        status,
        message: result.message || defaultMessage,
        latencyMs: result.latencyMs,
        statusCode: result.statusCode,
        detectedFormat: result.detectedFormat,
        checkType: result.checkType
      });
      return;
    }

    this.recordFailure(target, state, lastFailure?.errorType || "error", lastFailure?.message || "探测失败", {
      latencyMs: lastFailure?.latencyMs ?? null,
      statusCode: lastFailure?.statusCode ?? null,
      detectedFormat: lastFailure?.detectedFormat || null,
      checkType: lastFailure?.checkType || null
    });
  }

  recordFailure(target, state, type, message, details = {}) {
    this.recordResult(target, state, {
      status: "down",
      message,
      errorType: type,
      latencyMs: details.latencyMs ?? null,
      statusCode: details.statusCode ?? null,
      detectedFormat: details.detectedFormat ?? null,
      checkType: details.checkType ?? null
    });
  }

  recordResult(target, state, result) {
    if (state.removed) return;

    const checkedAt = new Date();
    const ok = ["up", "degraded"].includes(result.status);

    state.status = result.status;
    state.lastCheckedAt = checkedAt.toISOString();
    state.nextCheckAt = new Date(checkedAt.getTime() + target.intervalMs).toISOString();
    state.latencyMs = result.latencyMs;
    state.statusCode = result.statusCode;
    state.message = result.message;
    state.errorType = result.errorType || null;
    state.detectedFormat = result.detectedFormat || null;
    state.checkType = result.checkType || null;
    state.checkCount += 1;
    state.okCount += ok ? 1 : 0;
    state.failCount += ok ? 0 : 1;
    state.uptimePct = Math.round((state.okCount / state.checkCount) * 1000) / 10;
    state.history.push({
      at: state.lastCheckedAt,
      status: state.status,
      latencyMs: state.latencyMs,
      statusCode: state.statusCode
    });

    pruneHistory(state.history, {
      limit: this.historyLimit,
      retentionMs: this.historyRetentionMs
    });
    this.historyStore?.append?.(target.id, state.history.at(-1));

    this.emitResult(target, state);
    this.emitUpdate("result", target.id);
  }

  emitResult(target, state) {
    try {
      this.onResult({
        targetId: target.id,
        at: state.lastCheckedAt,
        status: state.status,
        message: state.message,
        latencyMs: state.latencyMs,
        statusCode: state.statusCode,
        detectedFormat: state.detectedFormat,
        checkType: state.checkType
      });
    } catch (_error) {
      // History persistence should not block live status updates.
    }
  }

  getSnapshot() {
    const now = new Date();
    const checks = this.targets.map((target) => {
      const state = this.states.get(target.id);
      if (!state) return null;
      const availability = buildAvailabilityWindows(state.history, now);
      const timeline = buildAvailabilityTimelines(state.history, now);
      const annotation = buildTargetAnnotation(target, state, availability);
      return {
        id: target.id,
        name: target.name,
        group: target.group,
        description: target.description,
        format: target.format,
        model: target.model,
        checkMode: target.checkMode,
        detectedFormat: state.detectedFormat,
        checkType: state.checkType,
        method: target.method,
        status: state.status,
        message: state.message,
        statusCode: state.statusCode,
        latencyMs: state.latencyMs,
        lastCheckedAt: state.lastCheckedAt,
        nextCheckAt: state.nextCheckAt,
        checkCount: state.checkCount,
        okCount: state.okCount,
        failCount: state.failCount,
        uptimePct: state.uptimePct,
        availability,
        timeline,
        annotation,
        history: state.history.slice(-24)
      };
    }).filter(Boolean);

    const summary = checks.reduce(
      (acc, check) => {
        acc.total += 1;
        acc[check.status] = (acc[check.status] || 0) + 1;
        return acc;
      },
      { total: 0, pending: 0, checking: 0, up: 0, degraded: 0, down: 0 }
    );

    return {
      generatedAt: now.toISOString(),
      startedAt: this.startedAt.toISOString(),
      summary,
      annotations: buildSnapshotAnnotations(checks),
      checks
    };
  }
}

function createInitialState(target, history = []) {
  const latest = history.at(-1);
  const checkCount = history.length;
  const okCount = history.filter((item) => isAvailableStatus(item.status)).length;
  const failCount = checkCount - okCount;

  return {
    id: target.id,
    status: latest?.status || "pending",
    previousStatus: "pending",
    message: latest ? "等待下次检查" : "等待首次检查",
    statusCode: latest?.statusCode ?? null,
    latencyMs: latest?.latencyMs ?? null,
    lastCheckedAt: latest?.at || null,
    nextCheckAt: new Date(Date.now() + target.intervalMs).toISOString(),
    checkCount,
    okCount,
    failCount,
    uptimePct: checkCount ? Math.round((okCount / checkCount) * 1000) / 10 : null,
    history,
    errorType: null,
    detectedFormat: null,
    checkType: null,
    inFlight: null,
    removed: false
  };
}

function pruneHistory(history, options = {}) {
  const limit = options.limit || 50000;
  const retentionMs = options.retentionMs || 30 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const timestamp = Date.parse(history[index]?.at || "");
    if (!Number.isFinite(timestamp) || timestamp < cutoff) {
      history.splice(index, 1);
    }
  }

  if (history.length > limit) {
    history.splice(0, history.length - limit);
  }

  return history;
}

function buildAvailabilityWindows(history, now = new Date()) {
  return Object.fromEntries(
    AVAILABILITY_WINDOWS.map((window) => [window.key, buildAvailabilityWindow(history, window, now)])
  );
}

function buildAvailabilityWindow(history, window, now = new Date()) {
  const nowMs = now.getTime();
  const cutoff = nowMs - window.ms;
  const samples = history.filter((item) => {
    const timestamp = Date.parse(item.at);
    return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= nowMs;
  });
  const up = samples.filter((item) => item.status === "up").length;
  const degraded = samples.filter((item) => item.status === "degraded").length;
  const down = samples.filter((item) => item.status === "down").length;
  const available = up + degraded;
  const sampleCount = samples.length;
  const firstSampleAt = samples[0]?.at || null;
  const coveragePct = firstSampleAt
    ? Math.min(100, Math.round(((nowMs - Date.parse(firstSampleAt)) / window.ms) * 1000) / 10)
    : 0;
  const availabilityPct = sampleCount
    ? Math.round((available / sampleCount) * 10000) / 100
    : null;

  return {
    key: window.key,
    label: window.label,
    sampleCount,
    up,
    degraded,
    down,
    available,
    availabilityPct,
    coveragePct,
    partial: coveragePct < 95,
    status: summarizeAvailabilityStatus({ sampleCount, down, degraded, availabilityPct }),
    from: new Date(cutoff).toISOString(),
    to: now.toISOString()
  };
}

function buildAvailabilityTimelines(history, now = new Date()) {
  return Object.fromEntries(
    AVAILABILITY_WINDOWS.map((window) => [window.key, buildAvailabilityTimeline(history, window, now)])
  );
}

function buildAvailabilityTimeline(history, window, now = new Date()) {
  const nowMs = now.getTime();
  const cutoff = nowMs - window.ms;
  const bucketMs = window.ms / window.buckets;
  const buckets = Array.from({ length: window.buckets }, (_item, index) => {
    const fromMs = cutoff + index * bucketMs;
    return {
      from: new Date(fromMs).toISOString(),
      to: new Date(fromMs + bucketMs).toISOString(),
      status: "unknown",
      sampleCount: 0,
      availabilityPct: null
    };
  });

  for (const item of history) {
    const timestamp = Date.parse(item.at);
    if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > nowMs) continue;
    const bucketIndex = Math.min(window.buckets - 1, Math.max(0, Math.floor((timestamp - cutoff) / bucketMs)));
    const bucket = buckets[bucketIndex];
    bucket.sampleCount += 1;
    bucket.up = (bucket.up || 0) + (item.status === "up" ? 1 : 0);
    bucket.degraded = (bucket.degraded || 0) + (item.status === "degraded" ? 1 : 0);
    bucket.down = (bucket.down || 0) + (item.status === "down" ? 1 : 0);
  }

  for (const bucket of buckets) {
    if (!bucket.sampleCount) continue;
    const available = (bucket.up || 0) + (bucket.degraded || 0);
    bucket.availabilityPct = Math.round((available / bucket.sampleCount) * 10000) / 100;
    bucket.status = summarizeAvailabilityStatus({
      sampleCount: bucket.sampleCount,
      down: bucket.down || 0,
      degraded: bucket.degraded || 0,
      availabilityPct: bucket.availabilityPct
    });
  }

  return buckets;
}

function summarizeAvailabilityStatus(stats) {
  if (!stats.sampleCount) return "unknown";
  if (stats.availabilityPct < 99 || stats.down > 0) return "down";
  if (stats.degraded > 0 || stats.availabilityPct < 100) return "degraded";
  return "up";
}

function buildTargetAnnotation(target, state, availability) {
  if (state.status === "down") {
    return {
      level: "critical",
      title: `${target.name} 当前不可用`,
      body: state.message || "最近一次探测失败，请检查上游中转站、余额、密钥或网络连通性。"
    };
  }

  if (state.status === "degraded") {
    return {
      level: "warning",
      title: `${target.name} 当前不稳定`,
      body: state.message || "服务可用但响应偏慢或模型列表未完全匹配。"
    };
  }

  const recent = availability["90m"];
  if (recent?.sampleCount && (recent.down > 0 || recent.degraded > 0)) {
    return {
      level: "warning",
      title: `${target.name} 最近 90 分钟有波动`,
      body: `记录到 ${recent.down} 次异常、${recent.degraded} 次偏慢，当前状态为${state.status === "up" ? "正常" : state.status}。`
    };
  }

  if (recent?.partial) {
    return {
      level: "info",
      title: `${target.name} 样本仍在积累`,
      body: `最近 90 分钟窗口覆盖约 ${recent.coveragePct}%，可用度会随着探测样本增加而更准确。`
    };
  }

  return null;
}

function buildSnapshotAnnotations(checks) {
  const annotations = checks
    .filter((check) => check.annotation)
    .map((check) => ({
      id: check.id,
      targetName: check.name,
      status: check.status,
      ...check.annotation
    }));

  if (!annotations.length && checks.length) {
    annotations.push({
      id: "all-clear",
      targetName: "全部组件",
      level: "success",
      title: "暂无不稳定批注",
      body: "当前所有已配置中转站都处于正常或等待探测状态。"
    });
  }

  return annotations;
}

function isAvailableStatus(status) {
  return status === "up" || status === "degraded";
}

async function runProbeAttempt(target, attempt) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), target.timeoutMs);

  try {
    const response = await fetch(attempt.url, {
      method: attempt.method,
      headers: attempt.headers,
      body: attempt.body,
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    const expected = attempt.expectedStatus
      ? attempt.expectedStatus.has(response.status)
      : response.status >= 200 && response.status < 300;

    if (!expected) {
      return {
        ok: false,
        errorType: "http",
        message: httpStatusMessage(response.status),
        latencyMs,
        statusCode: response.status,
        detectedFormat: attempt.format,
        checkType: attempt.checkType
      };
    }

    const validation = await validateResponse(target, attempt, response);
    if (validation.retry) {
      return {
        ok: false,
        errorType: "model",
        message: validation.message,
        latencyMs,
        statusCode: response.status,
        detectedFormat: attempt.format,
        checkType: attempt.checkType
      };
    }

    return {
      ok: true,
      status: validation.status,
      message: validation.message,
      latencyMs,
      statusCode: response.status,
      detectedFormat: attempt.format,
      checkType: attempt.checkType
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const type = error.name === "AbortError" ? "timeout" : "network";
    return {
      ok: false,
      errorType: type,
      message: type === "timeout" ? "请求超时" : safeNetworkMessage(error),
      latencyMs,
      statusCode: null,
      detectedFormat: attempt.format,
      checkType: attempt.checkType
    };
  } finally {
    clearTimeout(timeout);
  }
}

function safeNetworkMessage(error) {
  const code = error?.code || error?.cause?.code;
  if (code === "ENOTFOUND") return "域名解析失败";
  if (code === "ECONNREFUSED") return "连接被拒绝";
  if (code === "ECONNRESET") return "连接被重置";
  return "网络请求失败";
}

async function validateResponse(target, attempt, response) {
  if (attempt.checkType !== "models" || !target.model) {
    if (attempt.checkType === "chat") {
      return { message: "最小 token 实测通过" };
    }
    return {};
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_error) {
    if (target.checkMode === "auto") {
      return {
        retry: true,
        message: "模型列表无法解析"
      };
    }
    return {
      status: "degraded",
      message: "接口可用，模型列表无法解析"
    };
  }

  const models = Array.isArray(payload?.data) ? payload.data : [];
  const found = models.some((item) => item?.id === target.model || item === target.model);
  if (!found) {
    if (target.checkMode === "auto") {
      return {
        retry: true,
        message: "模型未在列表中"
      };
    }
    return {
      status: "degraded",
      message: "接口可用，模型未在列表中"
    };
  }

  return {
    message: "模型列表匹配"
  };
}

function httpStatusMessage(status) {
  if (status === 401 || status === 403) return "认证失败或无权限";
  if (status === 402) return "余额不足或账户受限";
  if (status === 404) return "接口路径不存在";
  if (status === 429) return "请求被限流";
  if (status >= 500) return "上游服务异常";
  return `HTTP ${status}`;
}

module.exports = {
  HealthMonitor,
  httpStatusMessage,
  safeNetworkMessage
};
