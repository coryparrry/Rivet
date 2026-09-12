import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  refreshReviewAuthority,
  replaceAuthorityDeclarations,
} from "../scripts/refresh-review-authority.mjs";

const execFileAsync = promisify(execFile);
const refreshReviewAuthorityPath = fileURLToPath(
  new URL("../scripts/refresh-review-authority.mjs", import.meta.url),
);

const ENGINES = ["claude", "codex", "copilot", "gemini"];
const TRUST_DECLARATION_NAMES = [
  "RIVET_REVIEW_AUTHORITY_SHA256_BY_POLICY",
  "RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE",
  "RIVET_REPAIR_AUTHORITY_SHA256_BY_ENGINE",
];
const MAINTENANCE_DECLARATION_NAMES = [
  "RIVET_MAINTENANCE_ACTIONS_SHA256_BY_ENGINE",
  "RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256_BY_ENGINE",
  "RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256_BY_ENGINE",
];
const hash = (character) => character.repeat(64);
const engineDeclaration = (name, character) =>
  `export const ${name} = Object.freeze({\n${ENGINES.map(
    (engine) => `  ${engine}: "${hash(character)}",`,
  ).join("\n")}\n});`;
const reviewDeclaration = (character) => {
  const keys = [];
  for (const triage of ["automatic", "disabled"])
    for (const inline of ["inline", "summary"])
      for (const decision of ["comment", "request-changes"])
        for (const engine of ENGINES)
          keys.push(`${triage}:${inline}:${decision}:${engine}`);
  return `export const RIVET_REVIEW_AUTHORITY_SHA256_BY_POLICY = Object.freeze({\n${keys
    .map((key) => `  "${key}": "${hash(character)}",`)
    .join("\n")}\n});`;
};
function declarations(character) {
  return {
    RIVET_REVIEW_AUTHORITY_SHA256_BY_POLICY: reviewDeclaration(character),
    RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE: engineDeclaration(
      "RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE",
      character,
    ),
    RIVET_MAINTENANCE_ACTIONS_SHA256_BY_ENGINE: engineDeclaration(
      "RIVET_MAINTENANCE_ACTIONS_SHA256_BY_ENGINE",
      character,
    ),
    RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256_BY_ENGINE: engineDeclaration(
      "RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256_BY_ENGINE",
      character,
    ),
    RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256_BY_ENGINE: engineDeclaration(
      "RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256_BY_ENGINE",
      character,
    ),
    RIVET_REPAIR_AUTHORITY_SHA256_BY_ENGINE: engineDeclaration(
      "RIVET_REPAIR_AUTHORITY_SHA256_BY_ENGINE",
      character,
    ),
  };
}

function sourceForDeclarations(allDeclarations, names) {
  return names.map((name) => allDeclarations[name]).join("\n");
}

async function runRefreshWithSources({
  trustSource,
  maintenanceSource,
  writes,
}) {
  const temporaryParent = await mkdtemp(
    path.join(os.tmpdir(), "rivet-refresh-authority-split-test-"),
  );
  try {
    await refreshReviewAuthority({
      temporaryParent,
      ensureBinary: async () => "pinned-gh-aw",
      readTrust: async () => trustSource,
      readMaintenanceTrust: async () => maintenanceSource,
      writeTrust: async (_path, value) => {
        writes.push({ source: "trust.mjs", value });
      },
      writeMaintenanceTrust: async (_path, value) => {
        writes.push({
          source: "maintenance-trust-inventory.mjs",
          value,
        });
      },
      compileWorkflow: async ({ repositoryRoot, workflowId }) => {
        await writeFile(
          path.join(
            repositoryRoot,
            ".github/workflows",
            `${workflowId}.lock.yml`,
          ),
          "compiled",
        );
      },
      validateWorkflow: async () => {},
      inspectWorkflow: () => ({}),
      write: true,
    });
  } finally {
    await rm(temporaryParent, { recursive: true, force: true });
  }
}

test("replaces every generated authority declaration as one validated set", () => {
  const originalDeclarations = declarations("a");
  const source = `before\n${Object.values(originalDeclarations).join("\n")}\nafter\n`;
  const replacements = declarations("b");
  const updated = replaceAuthorityDeclarations(source, replacements);

  assert.equal(
    updated,
    `before\n${Object.values(replacements).join("\n")}\nafter\n`,
  );
});

test("refuses incomplete, malformed, or duplicate authority inventories", () => {
  const original = declarations("a");
  const source = Object.values(original).join("\n");
  const incomplete = declarations("b");
  delete incomplete.RIVET_REPAIR_AUTHORITY_SHA256_BY_ENGINE;
  assert.throws(
    () => replaceAuthorityDeclarations(source, incomplete),
    /replacements are incomplete/,
  );

  const malformed = declarations("b");
  malformed.RIVET_MAINTENANCE_ACTIONS_SHA256_BY_ENGINE =
    'export const RIVET_MAINTENANCE_ACTIONS_SHA256_BY_ENGINE = "not-a-digest";';
  assert.throws(
    () => replaceAuthorityDeclarations(source, malformed),
    /must occur exactly once/,
  );

  assert.throws(
    () =>
      replaceAuthorityDeclarations(
        `${source}\n${original.RIVET_REPAIR_AUTHORITY_SHA256_BY_ENGINE}`,
        declarations("b"),
      ),
    /must occur exactly once/,
  );
});

test("compiles maintenance in both modes for every supported engine", async () => {
  const temporaryParent = await mkdtemp(
    path.join(os.tmpdir(), "rivet-refresh-authority-test-"),
  );
  const maintenanceVariants = [];
  const originalDeclarations = declarations("a");
  const source = sourceForDeclarations(
    originalDeclarations,
    TRUST_DECLARATION_NAMES,
  );
  const maintenanceSource = sourceForDeclarations(
    originalDeclarations,
    MAINTENANCE_DECLARATION_NAMES,
  );
  let updated;
  let updatedMaintenance;
  try {
    await refreshReviewAuthority({
      temporaryParent,
      ensureBinary: async () => "pinned-gh-aw",
      readTrust: async () => source,
      readMaintenanceTrust: async () => maintenanceSource,
      writeTrust: async (_path, value) => {
        updated = value;
      },
      writeMaintenanceTrust: async (_path, value) => {
        updatedMaintenance = value;
      },
      compileWorkflow: async ({ repositoryRoot, workflowId }) => {
        const workflowPath = path.join(
          repositoryRoot,
          ".github",
          "workflows",
          `${workflowId}.md`,
        );
        const workflow = await readFile(workflowPath, "utf8");
        if (workflowId === "rivet-maintenance") {
          maintenanceVariants.push({
            engine: workflow.match(/^engine: (.+)$/m)?.[1],
            mode: workflow.includes('cron: "17 3 * * 1"')
              ? "scheduled"
              : "manual",
          });
        }
        await writeFile(
          path.join(
            repositoryRoot,
            ".github",
            "workflows",
            `${workflowId}.lock.yml`,
          ),
          "compiled",
        );
      },
      validateWorkflow: async () => {},
      inspectWorkflow: () => ({}),
      write: true,
    });
  } finally {
    await rm(temporaryParent, { recursive: true, force: true });
  }

  assert.ok(updated);
  assert.ok(updatedMaintenance);
  assert.deepEqual(maintenanceVariants, [
    { engine: "claude", mode: "manual" },
    { engine: "claude", mode: "scheduled" },
    { engine: "codex", mode: "manual" },
    { engine: "codex", mode: "scheduled" },
    { engine: "copilot", mode: "manual" },
    { engine: "copilot", mode: "scheduled" },
    { engine: "gemini", mode: "manual" },
    { engine: "gemini", mode: "scheduled" },
  ]);
  for (const name of TRUST_DECLARATION_NAMES) {
    assert.match(updated, new RegExp(`${name} = `));
    assert.doesNotMatch(updated, new RegExp(`RIVET_MAINTENANCE_`));
  }
  assert.match(
    updated,
    /  "automatic:inline:comment:claude":\n    "[0-9a-f]{64}",/,
  );
  assert.doesNotMatch(
    updated,
    /  "(?:automatic|disabled):(?:inline|summary):(?:comment|request-changes):(?:claude|codex|copilot|gemini)": "[0-9a-f]{64}",/,
  );
  for (const name of MAINTENANCE_DECLARATION_NAMES) {
    assert.match(
      updatedMaintenance,
      new RegExp(`${name} = Object\\.freeze\\({`),
    );
    assert.doesNotMatch(
      updatedMaintenance,
      /RIVET_REVIEW_AUTHORITY|RIVET_ISSUE_TRIAGE_AUTHORITY|RIVET_REPAIR_AUTHORITY/,
    );
  }
});

test("validates both split authority sources before writing either", async () => {
  const original = declarations("a");
  const cases = [];
  for (const name of TRUST_DECLARATION_NAMES) {
    const missing = { ...original };
    delete missing[name];
    cases.push({
      label: `missing ${name} from trust.mjs`,
      trustSource: sourceForDeclarations(missing, TRUST_DECLARATION_NAMES),
      maintenanceSource: sourceForDeclarations(
        original,
        MAINTENANCE_DECLARATION_NAMES,
      ),
      error: new RegExp(
        `authority declaration ${name} must occur exactly once in trust\\.mjs`,
      ),
    });
    cases.push({
      label: `duplicate ${name} in trust.mjs`,
      trustSource: `${sourceForDeclarations(
        original,
        TRUST_DECLARATION_NAMES,
      )}\n${original[name]}`,
      maintenanceSource: sourceForDeclarations(
        original,
        MAINTENANCE_DECLARATION_NAMES,
      ),
      error: new RegExp(
        `authority declaration ${name} must occur exactly once in trust\\.mjs`,
      ),
    });
  }
  for (const name of MAINTENANCE_DECLARATION_NAMES) {
    const missing = { ...original };
    delete missing[name];
    cases.push({
      label: `missing ${name} from maintenance-trust-inventory.mjs`,
      trustSource: sourceForDeclarations(original, TRUST_DECLARATION_NAMES),
      maintenanceSource: sourceForDeclarations(
        missing,
        MAINTENANCE_DECLARATION_NAMES,
      ),
      error: new RegExp(
        `authority declaration ${name} must occur exactly once in maintenance-trust-inventory\\.mjs`,
      ),
    });
    cases.push({
      label: `duplicate ${name} in maintenance-trust-inventory.mjs`,
      trustSource: sourceForDeclarations(original, TRUST_DECLARATION_NAMES),
      maintenanceSource: `${sourceForDeclarations(
        original,
        MAINTENANCE_DECLARATION_NAMES,
      )}\n${original[name]}`,
      error: new RegExp(
        `authority declaration ${name} must occur exactly once in maintenance-trust-inventory\\.mjs`,
      ),
    });
  }
  for (const name of TRUST_DECLARATION_NAMES) {
    const malformed = { ...original };
    malformed[name] = `export const ${name} = "not-a-digest";`;
    cases.push({
      label: `malformed ${name} in trust.mjs`,
      trustSource: sourceForDeclarations(malformed, TRUST_DECLARATION_NAMES),
      maintenanceSource: sourceForDeclarations(
        original,
        MAINTENANCE_DECLARATION_NAMES,
      ),
      error: new RegExp(
        `authority declaration ${name} must occur exactly once in trust\\.mjs`,
      ),
    });
  }
  for (const name of MAINTENANCE_DECLARATION_NAMES) {
    const malformed = { ...original };
    malformed[name] = `export const ${name} = "not-a-digest";`;
    cases.push({
      label: `malformed ${name} in maintenance-trust-inventory.mjs`,
      trustSource: sourceForDeclarations(original, TRUST_DECLARATION_NAMES),
      maintenanceSource: sourceForDeclarations(
        malformed,
        MAINTENANCE_DECLARATION_NAMES,
      ),
      error: new RegExp(
        `authority declaration ${name} must occur exactly once in maintenance-trust-inventory\\.mjs`,
      ),
    });
  }

  for (const { label, trustSource, maintenanceSource, error } of cases) {
    const writes = [];
    await assert.rejects(
      runRefreshWithSources({ trustSource, maintenanceSource, writes }),
      error,
      label,
    );
    assert.deepEqual(writes, [], label);
  }
});

test("runs the refresh-review-authority CLI when invoked through a symlink", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rivet-refresh-authority-cli-"),
  );
  try {
    const alias = path.join(directory, "refresh-review-authority.mjs");
    await symlink(refreshReviewAuthorityPath, alias);
    await assert.rejects(
      execFileAsync(process.execPath, [alias, "--unexpected"]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(
          error.stderr,
          /usage: refresh-review-authority\.mjs \[--write\]/,
        );
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
