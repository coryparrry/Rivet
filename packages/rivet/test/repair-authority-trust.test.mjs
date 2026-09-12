import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { inspectCompiledWorkflow } from "../src/gh-aw/inspect.mjs";
import { assessRepairTrust } from "../src/gh-aw/trust.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REPAIR_LOCAL_ACTIONS = [
  "./.github/rivet/actions/publish-repair",
  "./.github/rivet/actions/validate-repair",
];

async function repairAuthority() {
  const encoded = await readFile(
    path.join(
      PACKAGE_ROOT,
      "test/fixtures/repair/rivet-repair.lock.yml.gz.b64",
    ),
    "utf8",
  );
  return inspectCompiledWorkflow(
    gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"),
  );
}

function assessRepair(authority, options = {}) {
  return assessRepairTrust({
    authority,
    expectedEngine: "codex",
    expectedImports: [".github/rivet/agents/fixer.md"],
    expectedLocalActions: REPAIR_LOCAL_ACTIONS,
    expectedModel: "gpt-5.6-luna",
    expectedValidationCommands: ["npm test"],
    ...options,
  });
}

test("accepts the pinned owner-authorized repair workflow", async () => {
  const trust = assessRepair(await repairAuthority());
  assert.deepEqual(trust, {
    trusted: true,
    baseContext: "owner-authorized pull request repair",
    violations: [],
  });
});

test("rejects repair authority, publication, and safe-output drift", async () => {
  const authority = await repairAuthority();
  const mutations = [
    [
      "trigger",
      { triggers: ["issue_comment", "workflow_dispatch"] },
      "repair workflow must use only issue_comment",
    ],
    [
      "write authority",
      {
        writeCapableJobs: authority.writeCapableJobs.map((job) =>
          job.job === "activation"
            ? { ...job, permissions: { ...job.permissions, contents: "write" } }
            : job,
        ),
      },
      "repair write authority differs from the approved inventory",
    ],
    [
      "safe output",
      {
        safeOutputConfig: {
          ...authority.safeOutputConfig,
          create_issue: { max: 1 },
        },
      },
      "repair safe outputs differ from the approved handler set and settings",
    ],
    [
      "local publisher",
      { localActions: ["./.github/rivet/actions/validate-repair"] },
      "repair local actions differ from the approved inventory",
    ],
  ];
  for (const [label, change, violation] of mutations) {
    const trust = assessRepair({ ...authority, ...change });
    assert.equal(trust.trusted, false, label);
    assert.ok(trust.violations.includes(violation), label);
  }
});

test("binds normalized repair validation commands", async () => {
  const authority = await repairAuthority();
  assert.equal(assessRepair(authority).trusted, true);
  assert.equal(
    assessRepair(authority, {
      expectedValidationCommands: [" npm test "],
    }).trusted,
    true,
  );
  assert.deepEqual(
    assessRepair(authority, {
      expectedValidationCommands: ["npm run check"],
    }).violations,
    ["repair workflow differs from the approved authority inventory"],
  );
});
