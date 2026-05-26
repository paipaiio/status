"use strict";

const crypto = require("node:crypto");

const COOKIE_NAME = "status_admin";

function createAdminAuth(options) {
  const username = String(options.username || "root");
  const password = String(options.password || "Admin@123");
  const ttlMs = Number(options.ttlMs) || 24 * 60 * 60 * 1000;
  const sessions = new Map();

  function verifyCredentials(input) {
    return (
      safeEqual(input?.username, username) &&
      safeEqual(input?.password, password)
    );
  }

  function createSession() {
    cleanup();
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + ttlMs;
    sessions.set(token, { token, username, expiresAt });
    return { token, username, expiresAt, maxAgeSeconds: Math.floor(ttlMs / 1000) };
  }

  function getSession(req) {
    cleanup();
    const token = parseCookies(req.headers.cookie || "")[COOKIE_NAME];
    if (!token) return null;

    const session = sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }

    return session;
  }

  function destroySession(req) {
    const token = parseCookies(req.headers.cookie || "")[COOKIE_NAME];
    if (token) sessions.delete(token);
  }

  function setSessionCookie(req, res, session) {
    const parts = [
      `${COOKIE_NAME}=${session.token}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      `Max-Age=${session.maxAgeSeconds}`
    ];
    if (isSecureRequest(req)) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  }

  function clearSessionCookie(req, res) {
    const parts = [
      `${COOKIE_NAME}=`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      "Max-Age=0"
    ];
    if (isSecureRequest(req)) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  }

  function cleanup() {
    const now = Date.now();
    for (const [token, session] of sessions.entries()) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
  }

  return {
    clearSessionCookie,
    createSession,
    destroySession,
    getSession,
    setSessionCookie,
    verifyCredentials
  };
}

function safeEqual(left, right) {
  const leftHash = crypto.createHash("sha256").update(String(left || "")).digest();
  const rightHash = crypto.createHash("sha256").update(String(right || "")).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function parseCookies(header) {
  const cookies = {};
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) continue;
    cookies[decodeURIComponent(rawName)] = decodeURIComponent(rawValue.join("="));
  }
  return cookies;
}

function isSecureRequest(req) {
  return Boolean(req.socket.encrypted || req.headers["x-forwarded-proto"] === "https");
}

module.exports = {
  COOKIE_NAME,
  createAdminAuth,
  parseCookies
};
