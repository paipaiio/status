"use strict";

const elements = {
  loginView: document.querySelector("#loginView"),
  adminView: document.querySelector("#adminView"),
  loginForm: document.querySelector("#loginForm"),
  targetForm: document.querySelector("#targetForm"),
  annotationForm: document.querySelector("#annotationForm"),
  annotationTarget: document.querySelector("#annotationTarget"),
  logoutButton: document.querySelector("#logoutButton"),
  refreshAnnotationsButton: document.querySelector("#refreshAnnotationsButton"),
  testNotificationButton: document.querySelector("#testNotificationButton"),
  managedList: document.querySelector("#managedList"),
  managedEmpty: document.querySelector("#managedEmpty"),
  annotationList: document.querySelector("#annotationList"),
  annotationEmpty: document.querySelector("#annotationEmpty"),
  message: document.querySelector("#message"),
  template: document.querySelector("#managedTargetTemplate"),
  annotationTemplate: document.querySelector("#annotationTemplate")
};

let messageTimer = null;

elements.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  login();
});

elements.targetForm.addEventListener("submit", (event) => {
  event.preventDefault();
  createTarget();
});

elements.annotationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  createAnnotation();
});

elements.logoutButton.addEventListener("click", () => logout());
elements.refreshAnnotationsButton.addEventListener("click", () => loadAnnotations());
elements.testNotificationButton.addEventListener("click", () => testNotification());

elements.managedList.addEventListener("click", (event) => {
  const button = event.target.closest(".delete-target");
  if (!button) return;
  deleteTarget(button.dataset.targetId, button);
});

elements.annotationList.addEventListener("click", (event) => {
  const resolveButton = event.target.closest(".resolve-annotation");
  if (resolveButton) {
    resolveAnnotation(resolveButton.dataset.annotationId, resolveButton);
    return;
  }

  const deleteButton = event.target.closest(".delete-annotation");
  if (deleteButton) {
    deleteAnnotation(deleteButton.dataset.annotationId, deleteButton);
  }
});

bootstrap();

async function bootstrap() {
  try {
    const session = await fetchJson("/api/admin/session");
    setAuthenticated(session.authenticated);
    if (session.authenticated) await loadAdminData();
  } catch (_error) {
    setAuthenticated(false);
  }
}

async function loadAdminData() {
  await Promise.all([loadTargets(), loadAnnotations()]);
}

async function login() {
  const submitButton = elements.loginForm.querySelector("button[type='submit']");
  submitButton.disabled = true;

  try {
    const form = new FormData(elements.loginForm);
    await fetchJson("/api/admin/login", {
      method: "POST",
      body: {
        username: form.get("username"),
        password: form.get("password")
      }
    });

    elements.loginForm.reset();
    setAuthenticated(true);
    await loadAdminData();
    showMessage("已登录");
  } catch (error) {
    showMessage(error.message || "登录失败");
  } finally {
    submitButton.disabled = false;
  }
}

async function logout() {
  elements.logoutButton.disabled = true;
  try {
    await fetchJson("/api/admin/logout", { method: "POST" });
    setAuthenticated(false);
    elements.managedList.replaceChildren();
    elements.annotationList.replaceChildren();
    showMessage("已退出");
  } catch (error) {
    showMessage(error.message || "退出失败");
  } finally {
    elements.logoutButton.disabled = false;
  }
}

async function loadTargets() {
  const data = await fetchJson("/api/admin/targets");
  renderTargets(data.targets || []);
  renderAnnotationTargetOptions(data.runtimeTargets || [], data.targets || []);
}

async function loadAnnotations() {
  const data = await fetchJson("/api/admin/annotations");
  renderAnnotations(data.annotations || []);
  if (data.targets) renderAnnotationTargetOptions(data.targets, []);
}

async function createTarget() {
  const submitButton = elements.targetForm.querySelector("button[type='submit']");
  submitButton.disabled = true;

  try {
    await fetchJson("/api/admin/targets", {
      method: "POST",
      body: readTargetForm()
    });

    elements.targetForm.reset();
    await loadAdminData();
    showMessage("已添加，首页会实时更新");
  } catch (error) {
    showMessage(error.message || "添加失败");
  } finally {
    submitButton.disabled = false;
  }
}

async function deleteTarget(targetId, button) {
  if (!targetId) return;
  if (!window.confirm("删除这个动态检测项？")) return;

  button.disabled = true;
  try {
    await fetchJson(`/api/admin/targets/${encodeURIComponent(targetId)}`, {
      method: "DELETE"
    });
    await loadTargets();
    showMessage("已删除");
  } catch (error) {
    showMessage(error.message || "删除失败");
  } finally {
    button.disabled = false;
  }
}

async function createAnnotation() {
  const submitButton = elements.annotationForm.querySelector("button[type='submit']");
  submitButton.disabled = true;

  try {
    await fetchJson("/api/admin/annotations", {
      method: "POST",
      body: readAnnotationForm()
    });

    elements.annotationForm.reset();
    elements.annotationForm.querySelector("[name='notify']").checked = true;
    await loadAnnotations();
    showMessage("批注已发布");
  } catch (error) {
    showMessage(error.message || "批注发布失败");
  } finally {
    submitButton.disabled = false;
  }
}

async function resolveAnnotation(annotationId, button) {
  if (!annotationId) return;
  button.disabled = true;
  try {
    await fetchJson(`/api/admin/annotations/${encodeURIComponent(annotationId)}/resolve`, {
      method: "PATCH"
    });
    await loadAnnotations();
    showMessage("批注已解决");
  } catch (error) {
    showMessage(error.message || "解决失败");
  } finally {
    button.disabled = false;
  }
}

async function deleteAnnotation(annotationId, button) {
  if (!annotationId) return;
  if (!window.confirm("删除这条批注？")) return;

  button.disabled = true;
  try {
    await fetchJson(`/api/admin/annotations/${encodeURIComponent(annotationId)}`, {
      method: "DELETE"
    });
    await loadAnnotations();
    showMessage("批注已删除");
  } catch (error) {
    showMessage(error.message || "删除失败");
  } finally {
    button.disabled = false;
  }
}

async function testNotification() {
  elements.testNotificationButton.disabled = true;
  try {
    const data = await fetchJson("/api/admin/notifications/test", { method: "POST" });
    showMessage(data.enabled ? "测试通知已发送" : "未配置通知 Webhook");
  } catch (error) {
    showMessage(error.message || "测试通知失败");
  } finally {
    elements.testNotificationButton.disabled = false;
  }
}

function setAuthenticated(isAuthenticated) {
  elements.loginView.hidden = isAuthenticated;
  elements.adminView.hidden = !isAuthenticated;
  elements.logoutButton.hidden = !isAuthenticated;
}

function readTargetForm() {
  const form = new FormData(elements.targetForm);
  const payload = {
    name: textField(form, "name"),
    baseUrl: textField(form, "baseUrl"),
    model: textField(form, "model"),
    apiKey: textField(form, "apiKey"),
    format: textField(form, "format") || "auto",
    checkMode: textField(form, "checkMode") || "auto"
  };

  addNumber(payload, form, "intervalSeconds");
  addNumber(payload, form, "timeoutMs");
  return payload;
}

function readAnnotationForm() {
  const form = new FormData(elements.annotationForm);
  return {
    targetId: textField(form, "targetId"),
    level: textField(form, "level") || "info",
    title: textField(form, "title"),
    body: textField(form, "body"),
    notify: form.get("notify") === "on"
  };
}

function textField(form, name) {
  return String(form.get(name) || "").trim();
}

function addNumber(payload, form, name) {
  const value = textField(form, name);
  if (value) payload[name] = Number(value);
}

function renderTargets(targets) {
  elements.managedList.replaceChildren();
  elements.managedEmpty.hidden = targets.length > 0;

  for (const target of targets) {
    const node = elements.template.content.firstElementChild.cloneNode(true);
    node.querySelector(".delete-target").dataset.targetId = target.id;
    setText(node, ".managed-name", target.name || target.id);
    setText(node, ".managed-format", `${target.format || "auto"} / ${target.checkMode || "auto"}`);
    setText(node, ".managed-meta", `${target.baseUrl} / ${target.model}`);
    setText(node, ".managed-key", target.apiKeyMask ? `key ${target.apiKeyMask}` : "key 已保存");
    elements.managedList.appendChild(node);
  }
}

function renderAnnotationTargetOptions(runtimeTargets, managedTargets) {
  const selected = elements.annotationTarget.value;
  const items = [...runtimeTargets, ...managedTargets];
  const seen = new Set();
  const options = [createOption("", "全局状态页")];

  for (const target of items) {
    const id = target.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push(createOption(id, target.name || id));
  }

  elements.annotationTarget.replaceChildren(...options);
  elements.annotationTarget.value = [...seen].includes(selected) ? selected : "";
}

function createOption(value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  return option;
}

function renderAnnotations(annotations) {
  elements.annotationList.replaceChildren();
  elements.annotationEmpty.hidden = annotations.length > 0;

  for (const annotation of annotations) {
    const node = elements.annotationTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add(`annotation-${annotation.level || "info"}`);
    node.querySelector(".resolve-annotation").dataset.annotationId = annotation.id;
    node.querySelector(".delete-annotation").dataset.annotationId = annotation.id;
    setText(node, ".annotation-title", annotation.title);
    setText(node, ".annotation-level", labelForLevel(annotation.level));
    setText(node, ".annotation-body", annotation.body);
    setText(node, ".annotation-meta", buildAnnotationMeta(annotation));
    elements.annotationList.appendChild(node);
  }
}

function labelForLevel(level) {
  const labels = {
    info: "提示",
    warning: "不稳定",
    critical: "异常",
    success: "恢复"
  };
  return labels[level] || level || "提示";
}

function buildAnnotationMeta(annotation) {
  const target = annotation.targetId ? `关联 ${annotation.targetId}` : "全局";
  const source = annotation.source === "integration" ? "外部接口" : "后台";
  const notify = annotation.notify ? "同步通知" : "不通知";
  return `${target} / ${source} / ${notify} / ${formatDate(annotation.createdAt)}`;
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function setText(root, selector, value) {
  root.querySelector(selector).textContent = String(value);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch (_error) {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }

  return payload;
}

function showMessage(text) {
  window.clearTimeout(messageTimer);
  elements.message.textContent = text;
  elements.message.classList.add("is-visible");
  messageTimer = window.setTimeout(() => {
    elements.message.classList.remove("is-visible");
  }, 2600);
}
