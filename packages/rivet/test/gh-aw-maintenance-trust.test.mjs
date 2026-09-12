import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { inspectCompiledWorkflow } from "../src/gh-aw/inspect.mjs";
import {
  assessMaintenanceTrust,
  RIVET_MAINTENANCE_ACTIONS_SHA256_BY_ENGINE,
  RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256_BY_ENGINE,
  RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256_BY_ENGINE,
} from "../src/gh-aw/trust.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const MAINTENANCE_LOCAL_ACTION = "./.github/rivet/actions/validate-audit";
const MAINTENANCE_ENGINES = ["claude", "codex", "copilot", "gemini"];

test("pins maintenance authority for every engine and rejects cross-engine drift", async () => {
  for (const engine of MAINTENANCE_ENGINES) {
    assert.match(
      RIVET_MAINTENANCE_ACTIONS_SHA256_BY_ENGINE[engine],
      /^[0-9a-f]{64}$/,
    );
    assert.match(
      RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256_BY_ENGINE[engine],
      /^[0-9a-f]{64}$/,
    );
    assert.match(
      RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256_BY_ENGINE[engine],
      /^[0-9a-f]{64}$/,
    );
  }

  const authority = await maintenanceFixtureAuthority("manual");
  const crossEngineTrust = assessMaintenanceTrust({
    authority,
    expectedEngine: "claude",
    expectedImports: [".github/rivet/agents/repository-auditor.md"],
    expectedLocalActions: [MAINTENANCE_LOCAL_ACTION],
    expectedModel: "claude-review-model",
    expectedTriggers: ["workflow_dispatch"],
  });
  assert.equal(crossEngineTrust.trusted, false);
  assert.ok(
    crossEngineTrust.violations.includes(
      "maintenance actions differ from the approved inventory",
    ),
  );
  assert.ok(
    crossEngineTrust.violations.includes(
      "maintenance secrets differ from the approved inventory",
    ),
  );

  const widenedTrust = assessMaintenanceTrust({
    authority: {
      ...authority,
      actions: authority.actions.map((action, index) =>
        index === 0 ? { ...action, uses: `${action.uses}-widened` } : action,
      ),
    },
    expectedEngine: "codex",
    expectedImports: [".github/rivet/agents/repository-auditor.md"],
    expectedLocalActions: [MAINTENANCE_LOCAL_ACTION],
    expectedModel: "gpt-5.6-luna",
    expectedTriggers: ["workflow_dispatch"],
  });
  assert.deepEqual(widenedTrust.violations, [
    "maintenance actions differ from the approved inventory",
  ]);

  const unknownEngineTrust = assessMaintenanceTrust({
    authority,
    expectedEngine: "unknown",
    expectedImports: [".github/rivet/agents/repository-auditor.md"],
    expectedLocalActions: [MAINTENANCE_LOCAL_ACTION],
    expectedModel: "unknown-model",
    expectedTriggers: ["workflow_dispatch"],
  });
  assert.equal(unknownEngineTrust.trusted, false);
  assert.ok(
    unknownEngineTrust.violations.includes(
      "maintenance engine is not approved",
    ),
  );
});

test("rejects maintenance mutation authority and non-default checkouts", async () => {
  const compiled = await maintenanceFixtureAuthority("scheduled");
  const authority = {
    ...compiled,
    triggers: ["schedule"],
    additionalRepositories: ["other/repository"],
    writeCapableJobs: [{ job: "publish", permissions: { issues: "write" } }],
    checkouts: [
      {
        repository: "other/repository",
        ref: "main",
        path: null,
        persistCredentials: true,
      },
    ],
  };
  const trust = assessMaintenanceTrust({
    authority,
    expectedEngine: "codex",
    expectedImports: [".github/rivet/agents/repository-auditor.md"],
    expectedModel: "gpt-5.6-luna",
    expectedTriggers: ["schedule", "workflow_dispatch"],
    expectedLocalActions: [MAINTENANCE_LOCAL_ACTION],
  });
  assert.deepEqual(trust, {
    trusted: false,
    baseContext: "maintenance default branch",
    violations: [
      "maintenance trigger differs from the approved inventory",
      "additional repository checkouts are not allowed",
      "checkouts must use the default branch without persisted credentials",
      "only conclusion may use workflow write authority for cancellation",
    ],
  });
});

test("accepts the pinned manual and scheduled maintenance authorities", async () => {
  for (const mode of ["manual", "scheduled"]) {
    const authority = await maintenanceFixtureAuthority(mode);
    const trust = assessMaintenanceTrust({
      authority,
      expectedActionsSha256: RIVET_MAINTENANCE_ACTIONS_SHA256_BY_ENGINE,
      expectedJobAuthoritySha256:
        RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256_BY_ENGINE,
      expectedEngine: "codex",
      expectedImports: [".github/rivet/agents/repository-auditor.md"],
      expectedJobConditionsSha256:
        RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256_BY_ENGINE,
      expectedLocalActions: [MAINTENANCE_LOCAL_ACTION],
      expectedModel: "gpt-5.6-luna",
      expectedTriggers:
        mode === "scheduled"
          ? ["schedule", "workflow_dispatch"]
          : ["workflow_dispatch"],
    });
    assert.equal(trust.trusted, true, trust.violations.join("; "));
  }
});

test("rejects maintenance action, script, secret, and condition drift", async () => {
  const authority = await maintenanceFixtureAuthority("manual");
  for (const [change, violation] of [
    [
      {
        actions: authority.actions.map((action, index) =>
          index === 0
            ? { ...action, with: { ...action.with, destination: "/tmp/other" } }
            : action,
        ),
      },
      "maintenance actions differ from the approved inventory",
    ],
    [
      {
        scripts: authority.scripts.map((script, index) =>
          index === 0
            ? { ...script, run: `${script.run}\necho changed` }
            : script,
        ),
      },
      "maintenance actions differ from the approved inventory",
    ],
    [
      {
        secrets: [...authority.secrets, "EXTRA_TOKEN"].sort(),
        manifestSecrets: [...authority.manifestSecrets, "EXTRA_TOKEN"].sort(),
      },
      "maintenance secrets differ from the approved inventory",
    ],
    [
      {
        jobConditions: {
          ...authority.jobConditions,
          agent: { ...authority.jobConditions.agent, if: null },
        },
      },
      "maintenance job conditions differ from the approved inventory",
    ],
  ]) {
    const trust = assessMaintenanceTrust({
      authority: { ...authority, ...change },
      expectedEngine: "codex",
      expectedImports: [".github/rivet/agents/repository-auditor.md"],
      expectedLocalActions: [MAINTENANCE_LOCAL_ACTION],
      expectedModel: "gpt-5.6-luna",
      expectedTriggers: ["workflow_dispatch"],
    });
    assert.deepEqual(trust.violations, [violation]);
  }
});

test("rejects maintenance runner, container, permission, env, and service drift", async () => {
  const authority = await maintenanceFixtureAuthority("manual");
  const changes = [
    ["agent", "runsOn", "self-hosted"],
    ["agent", "container", "ubuntu:latest"],
    ["agent", "permissions", { "*": "read" }],
    ["agent", "env", { ...authority.jobAuthority.agent.env, UNTRUSTED: "1" }],
    ["agent", "services", { database: { image: "postgres:latest" } }],
  ];
  for (const [job, field, value] of changes) {
    const jobAuthority = structuredClone(authority.jobAuthority);
    jobAuthority[job][field] = value;
    const trust = assessMaintenanceTrust({
      authority: { ...authority, jobAuthority },
      expectedEngine: "codex",
      expectedImports: [".github/rivet/agents/repository-auditor.md"],
      expectedLocalActions: [MAINTENANCE_LOCAL_ACTION],
      expectedModel: "gpt-5.6-luna",
      expectedTriggers: ["workflow_dispatch"],
    });
    assert.deepEqual(
      trust.violations,
      [
        "maintenance runner, container, permissions, environment, or services differ from the approved inventory",
      ],
      `${job}.${field} drift must fail closed`,
    );
  }
});

test("rejects maintenance workflow and deployment environment drift", async () => {
  const authority = await maintenanceFixtureAuthority("manual");
  const workflowEnv = { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" };
  const workflowTrust = assessMaintenanceTrust({
    authority: { ...authority, workflowEnv },
    expectedEngine: "codex",
    expectedImports: [".github/rivet/agents/repository-auditor.md"],
    expectedLocalActions: [MAINTENANCE_LOCAL_ACTION],
    expectedModel: "gpt-5.6-luna",
    expectedTriggers: ["workflow_dispatch"],
  });
  assert.deepEqual(workflowTrust.violations, [
    "maintenance runner, container, permissions, environment, or services differ from the approved inventory",
  ]);

  const jobAuthority = structuredClone(authority.jobAuthority);
  jobAuthority.agent.environment = "production";
  const jobTrust = assessMaintenanceTrust({
    authority: { ...authority, jobAuthority },
    expectedEngine: "codex",
    expectedImports: [".github/rivet/agents/repository-auditor.md"],
    expectedLocalActions: [MAINTENANCE_LOCAL_ACTION],
    expectedModel: "gpt-5.6-luna",
    expectedTriggers: ["workflow_dispatch"],
  });
  assert.deepEqual(jobTrust.violations, workflowTrust.violations);
});

async function maintenanceFixtureAuthority(mode) {
  const encoded = await readFile(
    path.join(
      PACKAGE_ROOT,
      `test/fixtures/maintenance/rivet-maintenance-${mode}.lock.yml.gz.b64`,
    ),
    "utf8",
  );
  return inspectCompiledWorkflow(
    gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"),
  );
}
