import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import {
  DEFAULT_RIVET_CONFIG,
  issueTriageWorkflowProjection,
  maintenanceWorkflowProjection,
  reviewWorkflowProjection,
  validateRivetConfig,
} from "../src/config.mjs";
import { renderRivetReviewWorkflow } from "../src/workflows/review.mjs";
import { renderRivetIssueTriageWorkflow } from "../src/workflows/issue-triage.mjs";
import { renderRivetMaintenanceWorkflow } from "../src/workflows/maintenance.mjs";
import { renderRivetRepairWorkflow } from "../src/workflows/repair.mjs";

function configuration(endpoint = {}) {
  const config = structuredClone(DEFAULT_RIVET_CONFIG);
  config.models.review.model = "provider/custom-response-model";
  config.models.review.endpoint = {
    baseUrl: "https://models.example.com/gateway/v1",
    apiKeySecret: "CUSTOM_MODEL_API_KEY",
    ...endpoint,
  };
  return config;
}

test("preserves endpoint configuration across review, triage and maintenance projections", () => {
  const config = configuration();
  config.maintenance.mode = "manual";
  assert.deepEqual(validateRivetConfig(config), config);
  for (const project of [
    reviewWorkflowProjection,
    issueTriageWorkflowProjection,
    maintenanceWorkflowProjection,
  ]) {
    assert.deepEqual(project(config).endpoint, config.models.review.endpoint);
  }
  assert.equal(
    Object.hasOwn(
      validateRivetConfig(DEFAULT_RIVET_CONFIG).models.review,
      "endpoint",
    ),
    false,
  );
});

test("renders the selected endpoint, dedicated credential and precise network hostname in every workflow", () => {
  const config = configuration();
  config.maintenance.mode = "scheduled";
  for (const render of [
    renderRivetReviewWorkflow,
    renderRivetIssueTriageWorkflow,
    renderRivetMaintenanceWorkflow,
    renderRivetRepairWorkflow,
  ]) {
    const source = render({ configuration: config });
    const frontmatter = parse(source.match(/^---\n([\s\S]*?)\n---/)[1]);
    assert.equal(frontmatter.model, "provider/custom-response-model");
    assert.deepEqual(frontmatter.engine, {
      id: "codex",
      env: {
        OPENAI_BASE_URL: "https://models.example.com/gateway/v1",
        CODEX_API_KEY: "${{ secrets.CUSTOM_MODEL_API_KEY }}",
        OPENAI_API_KEY: "${{ secrets.CUSTOM_MODEL_API_KEY }}",
      },
    });
    assert.deepEqual(frontmatter.network.allowed, [
      "defaults",
      "models.example.com",
    ]);
    assert.equal(frontmatter.sandbox.agent["model-fallback"], false);
    assert.equal(frontmatter.sandbox.agent["token-steering"], false);
  }
});

test("accepts HTTPS endpoints with root paths, nested paths and the default port", () => {
  for (const baseUrl of [
    "https://models.example.com",
    "https://models.example.com/",
    "https://MODELS.example.com:443/api/v1/",
    "https://api.openai.com/v1",
  ]) {
    assert.doesNotThrow(() => validateRivetConfig(configuration({ baseUrl })));
  }
});

test("rejects unsafe or unsupported endpoint URLs before compilation", () => {
  for (const baseUrl of [
    "http://models.example.com/v1",
    "https://user:secret@models.example.com/v1",
    "https://models.example.com/v1?api_key=secret",
    "https://models.example.com/v1#fragment",
    "https://models.example.com:8443/v1",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://localhost/v1",
    "https://*.example.com/v1",
    "https://models.example.com/a/../v1",
    "https://models.example.com/a/./v1",
    "https://models.example.com/v1\npermissions: write-all",
    "https://models.example.com/$(id)",
    "https://models.example.com/`id`",
    "https://models.example.com/%24%28id%29",
    "https://models.example.com\\@other.example.com/v1",
    "https://models.example.com/" + "a".repeat(2048),
    "https://...",
    "",
    null,
    7,
  ]) {
    assert.throws(
      () => validateRivetConfig(configuration({ baseUrl })),
      /models.review.endpoint/,
      String(baseUrl),
    );
  }
});

test("rejects credential injection and GitHub or App secrets as provider credentials", () => {
  for (const apiKeySecret of [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GH_AW_GITHUB_MCP_SERVER_TOKEN",
    "RIVET_APP_PRIVATE_KEY",
    "COPILOT_GITHUB_TOKEN",
    "KEY }}\npermissions: write-all",
    "9KEY",
    "key-name",
    "",
    "A".repeat(101),
    null,
    {},
    3,
  ]) {
    assert.throws(
      () => validateRivetConfig(configuration({ apiKeySecret })),
      /apiKeySecret/,
      String(apiKeySecret),
    );
  }
});

test("rejects incomplete endpoint objects and engines using another protocol", () => {
  for (const endpoint of [
    null,
    {},
    [],
    { baseUrl: "https://models.example.com" },
    { apiKeySecret: "CUSTOM_KEY" },
    { ...configuration().models.review.endpoint, apiKey: "literal-key" },
  ]) {
    const config = configuration();
    config.models.review.endpoint = endpoint;
    assert.throws(
      () => validateRivetConfig(config),
      /endpoint must contain only/,
    );
  }
  for (const engine of ["claude", "copilot", "gemini"]) {
    const config = configuration();
    config.models.review.engine = engine;
    assert.throws(
      () => validateRivetConfig(config),
      /endpoint requires the codex engine/,
    );
  }
});
