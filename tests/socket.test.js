"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createWebSocketAccept,
  encodeTextFrame
} = require("../src/socket");

test("createWebSocketAccept matches RFC example", () => {
  assert.equal(
    createWebSocketAccept("dGhlIHNhbXBsZSBub25jZQ=="),
    "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
  );
});

test("encodeTextFrame creates an unmasked text frame", () => {
  const frame = encodeTextFrame("ok");

  assert.equal(frame[0], 0x81);
  assert.equal(frame[1], 2);
  assert.equal(frame.subarray(2).toString("utf8"), "ok");
});
