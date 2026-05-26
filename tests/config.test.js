"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildOpenAiCompatibleUrl,
  discoverEnvTargets,
  expandEnvTokens,
  normalizeTarget,
  parseDotEnvContent,
  parseTargets
} = require("../src/config");

test("parseDotEnvContent reads simple key value pairs", () => {
  const parsed = parseDotEnvContent(`
    # comment
    PORT=3010
    API_KEY="secret"
    EMPTY=
  `);

  assert.deepEqual(parsed, {
    PORT: "3010",
    API_KEY: "secret",
    EMPTY: ""
  });
});

test("expandEnvTokens replaces placeholders recursively", () => {
  const expanded = expandEnvTokens(
    {
      headers: {
        Authorization: "Bearer ${TOKEN}"
      },
      body: ["${VALUE}"]
    },
    { TOKEN: "abc", VALUE: "ping" }
  );

  assert.deepEqual(expanded, {
    headers: {
      Authorization: "Bearer abc"
    },
    body: ["ping"]
  });
});

test("parseTargets normalizes safe target config", () => {
  const targets = parseTargets(
    JSON.stringify([
      {
        id: "relay",
        name: "Relay",
        url: "https://example.com/health",
        headers: {
          Authorization: "Bearer ${TOKEN}"
        },
        expectedStatus: [200, 204]
      }
    ]),
    { TOKEN: "abc" }
  );

  assert.equal(targets.length, 1);
  assert.equal(targets[0].headers.Authorization, "Bearer abc");
  assert.equal(targets[0].expectedStatus.has(204), true);
  assert.equal(targets[0].method, "GET");
});

test("discoverEnvTargets builds dynamic env groups", () => {
  const targets = discoverEnvTargets({
    API_1_NAME: "Primary",
    API_1_BASE_URL: "api.example.com",
    API_1_MODEL: "gpt-test",
    API_1_API_KEY: "secret",
    API_1_CHECK_MODE: "models",
    API_2_BASE_URL: "https://backup.example.com/v1",
    API_2_MODEL: "claude-test",
    API_2_API_KEY: "secret-2",
    API_2_CHECK_MODE: "chat"
  });

  assert.equal(targets.length, 2);
  assert.equal(targets[0].name, "Primary");
  assert.equal(targets[0].url, "https://api.example.com/v1/models");
  assert.equal(targets[0].checkMode, "models");
  assert.equal(targets[0].model, "gpt-test");
  assert.equal(targets[1].url, "https://backup.example.com/v1/chat/completions");
  assert.equal(targets[1].method, "POST");
  assert.match(targets[1].body, /"max_tokens":1/);
});

test("discoverEnvTargets supports anthropic format", () => {
  const [target] = discoverEnvTargets({
    API_1_BASE_URL: "https://api.anthropic.example",
    API_1_MODEL: "claude-test",
    API_1_API_KEY: "secret",
    API_1_FORMAT: "anthropic",
    API_1_CHECK_MODE: "chat"
  });

  assert.equal(target.format, "anthropic");
  assert.equal(target.url, "https://api.anthropic.example/v1/messages");
  assert.equal(target.headers["x-api-key"], "secret");
  assert.equal(target.headers["anthropic-version"], "2023-06-01");
  assert.match(target.body, /"max_tokens":1/);
});

test("discoverEnvTargets auto format tries model lists before chat probes", () => {
  const [target] = discoverEnvTargets({
    API_1_BASE_URL: "api.example.com",
    API_1_MODEL: "model-test",
    API_1_API_KEY: "secret"
  });

  assert.deepEqual(
    target.attempts.map((attempt) => `${attempt.format}:${attempt.checkType}`),
    ["openai:models", "anthropic:models", "openai:chat", "anthropic:chat"]
  );
});

test("buildOpenAiCompatibleUrl keeps existing v1 base paths", () => {
  assert.equal(
    buildOpenAiCompatibleUrl("https://example.com/proxy/v1", "models"),
    "https://example.com/proxy/v1/models"
  );
});

test("normalizeTarget rejects non-http protocols", () => {
  assert.throws(
    () =>
      normalizeTarget(
        {
          id: "bad",
          name: "Bad",
          url: "file:///etc/passwd"
        },
        0,
        {}
      ),
    /http or https/
  );
});
