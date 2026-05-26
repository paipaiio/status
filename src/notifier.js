"use strict";

class WebhookNotifier {
  constructor(options = {}) {
    this.urls = normalizeUrls(options.urls || "");
    this.token = options.token || "";
    this.timeoutMs = options.timeoutMs || 5000;
  }

  get enabled() {
    return this.urls.length > 0;
  }

  async notifyAnnotation(annotation, context = {}) {
    if (!this.enabled) return [];

    const payload = {
      event: "status.annotation.created",
      annotation,
      summary: context.summary || null,
      generatedAt: new Date().toISOString()
    };

    const results = await Promise.allSettled(
      this.urls.map((url) => this.postJson(url, payload))
    );

    return results.map((result, index) => {
      if (result.status === "fulfilled") {
        return { url: this.urls[index], ok: true, statusCode: result.value.statusCode };
      }
      return { url: this.urls[index], ok: false, error: "通知发送失败" };
    });
  }

  async postJson(url, payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Webhook returned HTTP ${response.status}`);
      }

      return { statusCode: response.status };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeUrls(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const url = new URL(item);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("Notification webhook URLs must use http or https");
      }
      return url.toString();
    });
}

module.exports = {
  WebhookNotifier,
  normalizeUrls
};
