import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { inspectCompiledWorkflow } from "../src/gh-aw/inspect.mjs";
import { assessIssueTriageTrust } from "../src/gh-aw/trust.mjs";
import { RIVET_ISSUE_TRIAGE_PUBLISH_SCRIPT } from "../src/workflows/issue-triage.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ISSUE_LOCAL_ACTIONS = ["./.github/rivet/actions/prepare-issue-context"];

async function issueTriageAuthority(engine = "codex") {
  const encoded = await readFile(
    path.join(
      PACKAGE_ROOT,
      `test/fixtures/issue-triage/rivet-issue-triage${engine === "codex" ? "" : `-${engine}`}.lock.yml.gz.b64`,
    ),
    "utf8",
  );
  return inspectCompiledWorkflow(
    gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"),
  );
}

function assess(authority, engine, model) {
  return assessIssueTriageTrust({
    authority,
    expectedEngine: engine,
    expectedImports: [".github/rivet/agents/issue-triager.md"],
    expectedLocalActions: ISSUE_LOCAL_ACTIONS,
    expectedModel: model,
    expectedPublisherScript: RIVET_ISSUE_TRIAGE_PUBLISH_SCRIPT,
  });
}

test("binds issue-triage safe-output handlers and settings", async () => {
  const models = {
    codex: "gpt-5.6-luna",
    claude: "claude-review-model",
    copilot: "copilot-review-model",
    gemini: "gemini-review-model",
  };
  for (const engine of Object.keys(models)) {
    const trust = assess(
      await issueTriageAuthority(engine),
      engine,
      models[engine],
    );
    assert.deepEqual(trust.violations, [], `${engine} baseline must pass`);
  }

  const authority = await issueTriageAuthority();
  const originalSerializedConfig = JSON.stringify(authority.safeOutputConfig);
  const withConfigMutation = (mutate) => {
    const safeOutputConfig = structuredClone(authority.safeOutputConfig);
    mutate(safeOutputConfig);
    const serializedConfig = JSON.stringify(safeOutputConfig);
    return {
      ...authority,
      safeOutputConfig,
      actions: authority.actions.map((action) =>
        action.env?.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG ===
        originalSerializedConfig
          ? {
              ...action,
              env: {
                ...action.env,
                GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG: serializedConfig,
              },
            }
          : action,
      ),
    };
  };
  const mutations = [
    withConfigMutation((config) => {
      config.create_issue = { max: 9999 };
    }),
    withConfigMutation((config) => {
      config.create_pull_request_review_comment = { max: 9999, side: "RIGHT" };
    }),
    withConfigMutation((config) => {
      config.publish_issue = { max: 1 };
    }),
    {
      ...authority,
      safeOutputSettings: {
        ...authority.safeOutputSettings,
        failureReportAsIssue: "true",
      },
    },
  ];
  for (const mutatedAuthority of mutations) {
    const trust = assess(mutatedAuthority, "codex", "gpt-5.6-luna");
    assert.ok(
      trust.violations.includes(
        "issue triage safe outputs differ from the approved handler set and settings",
      ),
      trust.violations.join("; "),
    );
  }
});
