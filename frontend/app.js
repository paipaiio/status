"use strict";

const params = new URLSearchParams(location.search);
const captureMode = params.get("capture") === "qq";
document.documentElement.classList.toggle("capture-mode", captureMode);

const stateLabels = {
  pending: "等待中",
  checking: "检查中",
  up: "正常",
  degraded: "不稳定",
  down: "异常",
  unknown: "无样本"
};

const windowLabels = {
  "90m": "最近 90 分钟",
  "24h": "最近 24 小时",
  "7d": "最近 7 天",
  "30d": "最近 30 天"
};

const elements = {
  socketBadge: document.querySelector("#socketBadge"),
  socketState: document.querySelector("#socketState"),
  syncTime: document.querySelector("#syncTime"),
  refreshButton: document.querySelector("#refreshButton"),
  overviewTitle: document.querySelector("#overviewTitle"),
  overviewText: document.querySelector("#overviewText"),
  overallDot: document.querySelector("#overallDot"),
  totalCount: document.querySelector("#totalCount"),
  upCount: document.querySelector("#upCount"),
  degradedCount: document.querySelector("#degradedCount"),
  downCount: document.querySelector("#downCount"),
  monitorList: document.querySelector("#monitorList"),
  annotationPanel: document.querySelector("#annotationPanel"),
  annotationList: document.querySelector("#annotationList"),
  emptyState: document.querySelector("#emptyState"),
  adminPanel: document.querySelector("#adminPanel"),
  manualToken: document.querySelector("#manualToken"),
  manualCheckButton: document.querySelector("#manualCheckButton"),
  copyStatusApiButton: document.querySelector("#copyStatusApiButton"),
  template: document.querySelector("#checkCardTemplate"),
  windowTabs: document.querySelectorAll("[data-window]")
};

let socket = null;
let reconnectTimer = null;
let fallbackTimer = null;
let reconnectDelay = 1000;
let lastSnapshot = null;
let selectedWindow = params.get("window") || window.localStorage.getItem("statusWindow") || "90m";

elements.refreshButton.addEventListener("click", () => loadStatus("手动刷新"));
elements.manualCheckButton.addEventListener("click", () => runManualCheck());
elements.copyStatusApiButton.addEventListener("click", () => copyText(`${location.origin}/api/status`));
elements.windowTabs.forEach((button) => {
  button.addEventListener("click", () => {
    selectedWindow = button.dataset.window;
    window.localStorage.setItem("statusWindow", selectedWindow);
    updateWindowTabs();
    if (lastSnapshot) renderStatus(lastSnapshot, "窗口切换");
  });
});

updateWindowTabs();
connectSocket();
window.setInterval(updateCountdowns, 1000);

function connectSocket() {
  window.clearTimeout(reconnectTimer);
  setSocketState("connecting", "连接中");

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/socket`);

  socket.addEventListener("open", () => {
    reconnectDelay = 1000;
    stopFallback();
    setSocketState("connected", "实时连接");
  });

  socket.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "status") {
        renderStatus(data, data.event || "socket");
      }
    } catch (_error) {
      setSocketState("degraded", "推送异常");
    }
  });

  socket.addEventListener("close", () => {
    setSocketState("disconnected", "重连中");
    startFallback();
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    setSocketState("disconnected", "连接异常");
  });
}

function scheduleReconnect() {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(connectSocket, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.8, 15000);
}

function startFallback() {
  if (fallbackTimer) return;
  loadStatus("HTTP 兜底");
  fallbackTimer = window.setInterval(() => loadStatus("HTTP 兜底"), 15000);
}

function stopFallback() {
  window.clearInterval(fallbackTimer);
  fallbackTimer = null;
}

async function loadStatus(source = "HTTP") {
  elements.refreshButton.disabled = true;
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error("status request failed");
    renderStatus(await response.json(), source);
  } catch (_error) {
    elements.syncTime.textContent = "同步失败";
  } finally {
    elements.refreshButton.disabled = false;
  }
}

async function runManualCheck() {
  const token = elements.manualToken.value.trim();
  if (!token) {
    elements.manualToken.focus();
    return;
  }

  elements.manualCheckButton.disabled = true;
  try {
    const response = await fetch("/api/check", {
      method: "POST",
      headers: {
        "X-Admin-Token": token
      }
    });
    if (!response.ok) throw new Error("manual check failed");
    renderStatus(await response.json(), "手动探测");
  } catch (_error) {
    elements.syncTime.textContent = "手动探测失败";
  } finally {
    elements.manualCheckButton.disabled = false;
  }
}

function renderStatus(data, source) {
  lastSnapshot = data;
  const summary = data.summary || {};
  const checks = Array.isArray(data.checks) ? data.checks : [];
  const captureInfo = captureMode ? buildCaptureInfo(checks.length) : null;
  const visibleChecks = captureInfo ? checks.slice(captureInfo.startIndex, captureInfo.endIndex) : checks;

  elements.totalCount.textContent = String(summary.total || 0);
  elements.upCount.textContent = String(summary.up || 0);
  elements.degradedCount.textContent = String(summary.degraded || 0);
  elements.downCount.textContent = String(summary.down || 0);
  elements.syncTime.textContent = `${labelForSource(source)} ${formatTime(data.generatedAt)}`;
  elements.adminPanel.hidden = captureMode || !data.manualCheckEnabled;

  renderOverview(summary, captureInfo);
  renderChecks(visibleChecks);
  renderAnnotations(filterAnnotations(data.annotations || [], visibleChecks, captureInfo));
  elements.emptyState.hidden = checks.length > 0;
}

function buildCaptureInfo(totalChecks) {
  const perPage = positiveInteger(params.get("capturePerPage"), 4);
  const fallbackPages = Math.max(1, Math.ceil((totalChecks || 1) / perPage));
  const pageCount = positiveInteger(params.get("capturePages"), fallbackPages);
  const page = Math.min(pageCount, positiveInteger(params.get("capturePage"), 1));
  const startIndex = Math.max(0, (page - 1) * perPage);
  const endIndex = Math.min(totalChecks, startIndex + perPage);

  return {
    page,
    pageCount,
    perPage,
    totalChecks,
    startIndex,
    endIndex,
    hasMultiplePages: pageCount > 1
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function renderOverview(summary, captureInfo = null) {
  const total = summary.total || 0;
  const down = summary.down || 0;
  const degraded = summary.degraded || 0;
  const checking = summary.checking || 0;
  const pending = summary.pending || 0;
  let status = "pending";
  let title = "正在加载状态";
  let text = "后端会持续探测各中转站，前端只展示脱敏后的状态与可用度。";

  if (!total) {
    title = "暂无监控组件";
    text = "添加中转站配置后，这里会展示整体可用状态。";
  } else if (down > 0) {
    status = "down";
    title = "部分服务异常";
    text = `${down} 个组件当前不可用，请查看下方批注和最近可用度。`;
  } else if (degraded > 0) {
    status = "degraded";
    title = "部分服务不稳定";
    text = `${degraded} 个组件响应偏慢或探测结果不完整，建议继续观察最近 90 分钟和 24 小时窗口。`;
  } else if (checking > 0 || pending > 0) {
    status = "checking";
    title = "正在更新检查结果";
    text = "部分组件正在探测，实时推送会在结果返回后刷新页面。";
  } else {
    status = "up";
    title = "所有系统运行正常";
    text = "当前所有已配置中转站都处于可用状态。";
  }

  if (captureInfo?.hasMultiplePages) {
    const range = captureInfo.endIndex > captureInfo.startIndex
      ? `${captureInfo.startIndex + 1}-${captureInfo.endIndex}`
      : "0";
    text = `${text} 截图 ${captureInfo.page}/${captureInfo.pageCount}，本页 ${range}/${captureInfo.totalChecks} 个模型。`;
  }

  elements.overviewTitle.textContent = title;
  elements.overviewText.textContent = text;
  elements.overallDot.className = `overall-dot status-${status}`;
}

function renderChecks(checks) {
  elements.monitorList.replaceChildren();
  const groups = groupChecks(checks);

  for (const [groupName, groupChecksList] of groups) {
    const group = document.createElement("section");
    group.className = "component-group";
    group.setAttribute("aria-label", groupName);

    const heading = document.createElement("h3");
    heading.className = "component-group-title";
    heading.textContent = groupName;
    group.appendChild(heading);

    for (const check of groupChecksList) {
      group.appendChild(renderCheckCard(check));
    }

    elements.monitorList.appendChild(group);
  }
}

function renderCheckCard(check) {
  const node = elements.template.content.firstElementChild.cloneNode(true);
  node.classList.add(`status-${check.status || "pending"}`);

  setText(node, ".check-name", check.name || check.id || "未命名接口");
  setText(node, ".status-label", stateLabels[check.status] || check.status || "未知");
  setText(node, ".check-meta", buildMeta(check));
  setText(node, ".latency", check.latencyMs === null || check.latencyMs === undefined ? "-" : `${check.latencyMs} ms`);
  setText(node, ".status-code", check.statusCode || "-");
  setText(node, ".probe-type", displayMethod(check));

  const nextCheck = node.querySelector(".next-check");
  nextCheck.dataset.nextCheckAt = check.nextCheckAt || "";
  nextCheck.textContent = formatRelative(check.nextCheckAt);

  renderWindowMetrics(node, check.availability || {});
  renderTimeline(node, check);
  renderCheckAnnotation(node, check.annotation);
  return node;
}

function groupChecks(checks) {
  const groups = new Map();
  for (const check of checks) {
    const groupName = check.group || "默认分组";
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push(check);
  }
  return groups;
}

function renderWindowMetrics(node, availability) {
  for (const key of Object.keys(windowLabels)) {
    const metric = node.querySelector(`[data-metric="${key}"]`);
    const value = availability[key];
    metric.classList.toggle("is-selected", key === selectedWindow);
    metric.querySelector("strong").textContent = formatAvailability(value);
    metric.title = buildAvailabilityTitle(value);
  }
}

function renderTimeline(node, check) {
  const timeline = node.querySelector(".timeline");
  const selectedAvailability = check.availability?.[selectedWindow];
  const buckets = check.timeline?.[selectedWindow] || [];

  setText(node, ".timeline-label", windowLabels[selectedWindow] || selectedWindow);
  setText(node, ".timeline-uptime", formatAvailability(selectedAvailability));
  timeline.replaceChildren();
  timeline.style.setProperty("--bucket-count", String(Math.max(1, buckets.length || 1)));

  const renderedBuckets = buckets.length ? buckets : [{ status: "unknown", sampleCount: 0 }];
  for (const bucket of renderedBuckets) {
    const bar = document.createElement("span");
    bar.className = `timeline-bar status-${bucket.status || "unknown"}`;
    bar.title = buildBucketTitle(bucket);
    timeline.appendChild(bar);
  }
}

function renderCheckAnnotation(node, annotation) {
  const note = node.querySelector(".component-note");
  if (!annotation || (captureMode && ["success", "info"].includes(annotation.level))) {
    note.hidden = true;
    return;
  }

  note.hidden = false;
  note.classList.add(`note-${annotation.level || "info"}`);
  note.textContent = `${annotation.title}：${annotation.body}`;
}

function renderAnnotations(annotations) {
  elements.annotationPanel.hidden = captureMode && annotations.length === 0;
  elements.annotationList.replaceChildren();
  const items = annotations.length
    ? annotations
    : [{
        level: "info",
        title: "暂无批注",
        body: "等待首次探测完成后，这里会展示不稳定说明。"
      }];

  for (const annotation of items) {
    const item = document.createElement("article");
    item.className = `annotation-item note-${annotation.level || "info"}`;

    const title = document.createElement("h3");
    title.textContent = annotation.title || annotation.targetName || "状态批注";

    const body = document.createElement("p");
    body.textContent = annotation.body || "";

    item.append(title, body);
    elements.annotationList.appendChild(item);
  }
}

function filterAnnotations(annotations, visibleChecks, captureInfo) {
  if (!captureMode) return annotations;

  const visibleIds = new Set(visibleChecks.map((check) => check.id));
  return annotations.filter((annotation) => {
    if (annotation.level === "success" || annotation.level === "info") return false;
    if (!annotation.id || annotation.id === "all-clear") return true;
    return visibleIds.has(annotation.id);
  });
}

function buildMeta(check) {
  const model = check.model ? `模型 ${check.model}` : "";
  const format = check.detectedFormat
    ? `${check.detectedFormat} 格式`
    : check.format && check.format !== "auto"
      ? `${check.format} 格式`
      : "自动格式";
  const parts = [check.group, model, format, check.message].filter(Boolean);
  return parts.join(" / ");
}

function displayMethod(check) {
  if (check.checkType === "models") return "MODELS";
  if (check.checkType === "chat") return "CHAT";
  return check.method || "GET";
}

function formatAvailability(value) {
  if (!value || value.availabilityPct === null || value.availabilityPct === undefined) {
    return "样本不足";
  }

  const prefix = `${value.availabilityPct.toFixed(2)}%`;
  return value.partial ? `${prefix}*` : prefix;
}

function buildAvailabilityTitle(value) {
  if (!value) return "暂无样本";
  const sampleText = `${value.sampleCount || 0} 次样本`;
  const coverageText = value.partial ? `，窗口覆盖约 ${value.coveragePct}%` : "";
  return `${value.label || ""} ${formatAvailability(value)}，${sampleText}${coverageText}`;
}

function buildBucketTitle(bucket) {
  const status = stateLabels[bucket.status] || bucket.status || "未知";
  const uptime = bucket.availabilityPct === null || bucket.availabilityPct === undefined
    ? "样本不足"
    : `${bucket.availabilityPct.toFixed(2)}%`;
  return `${formatTime(bucket.from)} - ${formatTime(bucket.to)} / ${status} / ${uptime}`;
}

function updateWindowTabs() {
  elements.windowTabs.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.window === selectedWindow);
    button.setAttribute("aria-selected", button.dataset.window === selectedWindow ? "true" : "false");
  });
}

function setSocketState(state, label) {
  elements.socketBadge.className = `socket-badge socket-${state}`;
  elements.socketState.textContent = label;
}

function labelForSource(source) {
  if (source === "connected") return "已连接";
  if (source === "checking") return "正在检查";
  if (source === "result" || source === "socket") return "实时更新";
  return source;
}

function updateCountdowns() {
  document.querySelectorAll(".next-check").forEach((element) => {
    element.textContent = formatRelative(element.dataset.nextCheckAt);
  });
}

function setText(root, selector, value) {
  const element = root.querySelector(selector);
  element.textContent = String(value);
}

function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatRelative(value) {
  if (!value) return "-";
  const diff = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(diff)) return "-";
  if (diff <= 0) return "即将开始";
  return `${Math.ceil(diff / 1000)} 秒`;
}

async function copyText(value) {
  await navigator.clipboard.writeText(value);
  elements.syncTime.textContent = "状态接口已复制";
}
