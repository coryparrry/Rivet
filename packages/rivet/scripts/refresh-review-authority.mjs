import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import { ensureGhAwBinary } from "../src/gh-aw/binary.mjs";
import {
  compileGhAwWorkflow,
  validateGhAwWorkflow,
} from "../src/gh-aw/compile.mjs";
import { inspectCompiledWorkflow } from "../src/gh-aw/inspect.mjs";
import {
  issueTriageAuthorityDigest,
  maintenanceAuthorityDigests,
  repairAuthorityDigest,
  reviewAuthorityDigest,
} from "../src/gh-aw/trust.mjs";
import { renderRivetIssueTriageWorkflow } from "../src/workflows/issue-triage.mjs";
import { renderRivetMaintenanceWorkflow } from "../src/workflows/maintenance.mjs";
import { renderRivetRepairWorkflow } from "../src/workflows/repair.mjs";
import { renderRivetReviewWorkflow } from "../src/workflows/review.mjs";

export const AUTHORITY_ENGINES = Object.freeze([
  "claude",
  "codex",
  "copilot",
  "gemini",
]);

const REPAIR_VALIDATION_COMMANDS = Object.freeze(["npm test"]);
const AUTHORITY_DECLARATION_NAMES = Object.freeze([
  "RIVET_REVIEW_AUTHORITY_SHA256_BY_POLICY",
  "RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE",
  "RIVET_MAINTENANCE_ACTIONS_SHA256",
  "RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256",
  "RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256",
  "RIVET_REPAIR_AUTHORITY_SHA256_BY_ENGINE",
]);
const OBJECT_DECLARATION_NAMES = new Set([
  "RIVET_REVIEW_AUTHORITY_SHA256_BY_POLICY",
  "RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE",
  "RIVET_REPAIR_AUTHORITY_SHA256_BY_ENGINE",
]);
const AGENT_ASSET_ROOT = new URL("../assets/agents/", import.meta.url);
const TRUST_PATH = new URL("../src/gh-aw/trust.mjs", import.meta.url);

const WORKFLOW_ASSETS = Object.freeze({
  review: Object.freeze({
    workflowId: "rivet-review",
    assetRoot: new URL("../assets/review/", import.meta.url),
    agentProfile: "pr-reviewer.md",
    workflowPath: ".github/workflows/rivet-review.md",
  }),
  issueTriage: Object.freeze({
    workflowId: "rivet-issue-triage",
    assetRoot: new URL("../assets/issue/", import.meta.url),
    agentProfile: "issue-triager.md",
    workflowPath: ".github/workflows/rivet-issue-triage.md",
  }),
  maintenance: Object.freeze({
    workflowId: "rivet-maintenance",
    assetRoot: new URL("../assets/maintenance/", import.meta.url),
    agentProfile: "repository-auditor.md",
    workflowPath: ".github/workflows/rivet-maintenance.md",
  }),
  repair: Object.freeze({
    workflowId: "rivet-repair",
    assetRoot: new URL("../assets/repair/", import.meta.url),
    agentProfile: "fixer.md",
    workflowPath: ".github/workflows/rivet-repair.md",
  }),
});

function fail(message) {
  throw new Error(`refresh-review-authority: ${message}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function authorityDeclarationPattern(name) {
  const escaped = escapeRegExp(name);
  return OBJECT_DECLARATION_NAMES.has(name)
    ? new RegExp(
        `^export const ${escaped} = Object\\.freeze\\((?:\\{\\}|\\{\\n(?:  [^\\r\\n]+\\n)*\\})\\);$`,
        "gm",
      )
    : new RegExp(
        `^export const ${escaped} =\\n  "[^"\\r\\n]*";$`,
        "gm",
      );
}

function locateAuthorityDeclaration(source, name) {
  const pattern = authorityDeclarationPattern(name);
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `authority declaration ${name} must occur exactly once in trust.mjs`,
    );
  }
  const [match] = matches;
  const text = match[0];
  return {
    end: match.index + text.length,
    kind: text.includes("Object.freeze({") ? "engine" : "scalar",
    start: match.index,
    text,
  };
}

function validateAuthorityReplacement(name, replacement) {
  if (typeof replacement !== "string") {
    throw new Error(`authority replacement ${name} must be a declaration string`);
  }
  const located = locateAuthorityDeclaration(replacement, name);
  if (located.start !== 0 || located.end !== replacement.length) {
    throw new Error(
      `authority replacement ${name} must contain exactly one declaration`,
    );
  }
  const expectedKind = OBJECT_DECLARATION_NAMES.has(name) ? "engine" : "scalar";
  if (located.kind !== expectedKind) {
    throw new Error(`authority replacement ${name} has the wrong declaration shape`);
  }
}

/**
 * Replace every generated authority declaration atomically.
 *
 * This intentionally accepts complete declaration strings, rather than
 * searching for individual hash literals. That keeps --write limited to the
 * exact declarations and makes malformed or incomplete source fail closed
 * before any replacement is returned to the caller.
 */
export function replaceAuthorityDeclarations(source, replacements) {
  if (typeof source !== "string") {
    throw new Error("trust.mjs source must be a string");
  }
  if (
    !replacements ||
    typeof replacements !== "object" ||
    Array.isArray(replacements) ||
    JSON.stringify(Object.keys(replacements).sort()) !==
      JSON.stringify([...AUTHORITY_DECLARATION_NAMES].sort())
  ) {
    throw new Error("authority declaration replacements are incomplete");
  }

  const located = AUTHORITY_DECLARATION_NAMES.map((name) => {
    const declaration = locateAuthorityDeclaration(source, name);
    validateAuthorityReplacement(name, replacements[name]);
    return { ...declaration, name, replacement: replacements[name] };
  });

  let updated = source;
  for (const declaration of [...located].sort(
    (left, right) => right.start - left.start,
  )) {
    updated =
      updated.slice(0, declaration.start) +
      declaration.replacement +
      updated.slice(declaration.end);
  }
  return updated;
}

function digestValue(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} did not produce a SHA-256 digest`);
  }
  return value;
}

function engineDeclaration(name, hashes) {
  if (
    !hashes ||
    typeof hashes !== "object" ||
    Array.isArray(hashes) ||
    JSON.stringify(Object.keys(hashes).sort()) !==
      JSON.stringify([...AUTHORITY_ENGINES].sort())
  ) {
    throw new Error(`authority inventory ${name} is incomplete`);
  }
  return `export const ${name} = Object.freeze({\n${AUTHORITY_ENGINES.map(
    (engine) =>
      `  ${engine}: "${digestValue(hashes[engine], `${name}.${engine}`)}",`,
  ).join("\n")}\n});`;
}

function reviewPolicyDeclaration(hashes) {
  const expectedKeys = [];
  for (const triage of ["automatic", "disabled"]) {
    for (const inline of [true, false]) {
      for (const requestChanges of [false, true]) {
        for (const engine of AUTHORITY_ENGINES) {
          expectedKeys.push(
            [
              triage,
              inline ? "inline" : "summary",
              requestChanges ? "request-changes" : "comment",
              engine,
            ].join(":"),
          );
        }
      }
    }
  }
  if (
    !hashes ||
    typeof hashes !== "object" ||
    Array.isArray(hashes) ||
    JSON.stringify(Object.keys(hashes).sort()) !==
      JSON.stringify([...expectedKeys].sort())
  ) {
    throw new Error("review authority policy inventory is incomplete");
  }
  const name = "RIVET_REVIEW_AUTHORITY_SHA256_BY_POLICY";
  return `export const ${name} = Object.freeze({\n${expectedKeys
    .map((key) => `  "${key}": "${digestValue(hashes[key], `${name}.${key}`)}",`)
    .join("\n")}\n});`;
}

function scalarDeclaration(name, hash) {
  return `export const ${name} =\n  "${digestValue(hash, name)}";`;
}

function authorityDeclarations({ review, issueTriage, maintenance, repair }) {
  return {
    RIVET_REVIEW_AUTHORITY_SHA256_BY_POLICY:
      reviewPolicyDeclaration(review),
    RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE: engineDeclaration(
      "RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE",
      issueTriage,
    ),
    RIVET_MAINTENANCE_ACTIONS_SHA256: scalarDeclaration(
      "RIVET_MAINTENANCE_ACTIONS_SHA256",
      maintenance.actions,
    ),
    RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256: scalarDeclaration(
      "RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256",
      maintenance.jobConditions,
    ),
    RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256: scalarDeclaration(
      "RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256",
      maintenance.jobAuthority,
    ),
    RIVET_REPAIR_AUTHORITY_SHA256_BY_ENGINE: engineDeclaration(
      "RIVET_REPAIR_AUTHORITY_SHA256_BY_ENGINE",
      repair,
    ),
  };
}

function workflowConfiguration(engine) {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.models.review.engine = engine;
  if (engine !== "codex") {
    configuration.models.review.model = `${engine}-review-model`;
  }
  return configuration;
}

async function inspectGeneratedWorkflow({
  descriptor,
  configuration,
  render,
  renderOptions = {},
  binaryPath,
  temporaryParent,
  compileWorkflow,
  validateWorkflow,
  inspectWorkflow,
}) {
  const repositoryRoot = await realpath(
    await mkdtemp(
      path.join(temporaryParent, `rivet-${descriptor.workflowId}-authority-`),
    ),
  );
  try {
    await cp(descriptor.assetRoot, repositoryRoot, { recursive: true });
    await mkdir(path.join(repositoryRoot, ".github/rivet/agents"), {
      recursive: true,
    });
    await mkdir(path.join(repositoryRoot, ".github/workflows"), {
      recursive: true,
    });
    await cp(
      new URL(descriptor.agentProfile, AGENT_ASSET_ROOT),
      path.join(
        repositoryRoot,
        ".github/rivet/agents",
        descriptor.agentProfile,
      ),
    );
    await writeFile(
      path.join(repositoryRoot, descriptor.workflowPath),
      render({ configuration, ...renderOptions }),
    );
    await compileWorkflow({
      repositoryRoot,
      workflowId: descriptor.workflowId,
      binaryPath,
    });
    await validateWorkflow({
      repositoryRoot,
      workflowId: descriptor.workflowId,
      binaryPath,
    });
    const source = await readFile(
      path.join(
        repositoryRoot,
        ".github/workflows",
        `${descriptor.workflowId}.lock.yml`,
      ),
      "utf8",
    );
    return inspectWorkflow(source);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
}

async function generateReviewInventories({
  binaryPath,
  temporaryParent,
  compileWorkflow,
  validateWorkflow,
  inspectWorkflow,
}) {
  const inventories = {};
  for (const triage of ["automatic", "disabled"]) {
    for (const inline of [true, false]) {
      for (const requestChanges of [false, true]) {
        for (const engine of AUTHORITY_ENGINES) {
          const configuration = workflowConfiguration(engine);
          configuration.issues.triage = triage;
          configuration.review.inlineFindings = inline;
          configuration.review.requestChanges = requestChanges;
          const authority = await inspectGeneratedWorkflow({
            descriptor: WORKFLOW_ASSETS.review,
            configuration,
            render: renderRivetReviewWorkflow,
            binaryPath,
            temporaryParent,
            compileWorkflow,
            validateWorkflow,
            inspectWorkflow,
          });
          const key = [
            triage,
            inline ? "inline" : "summary",
            requestChanges ? "request-changes" : "comment",
            engine,
          ].join(":");
          inventories[key] = reviewAuthorityDigest(authority);
        }
      }
    }
  }
  return inventories;
}

async function generateIssueTriageInventory({
  binaryPath,
  temporaryParent,
  compileWorkflow,
  validateWorkflow,
  inspectWorkflow,
}) {
  const hashes = {};
  for (const engine of AUTHORITY_ENGINES) {
    const authority = await inspectGeneratedWorkflow({
      descriptor: WORKFLOW_ASSETS.issueTriage,
      configuration: workflowConfiguration(engine),
      render: renderRivetIssueTriageWorkflow,
      binaryPath,
      temporaryParent,
      compileWorkflow,
      validateWorkflow,
      inspectWorkflow,
    });
    hashes[engine] = issueTriageAuthorityDigest(authority);
  }
  return hashes;
}

async function generateMaintenanceInventory({
  binaryPath,
  temporaryParent,
  compileWorkflow,
  validateWorkflow,
  inspectWorkflow,
}) {
  let normalized;
  for (const mode of ["manual", "scheduled"]) {
    const configuration = workflowConfiguration("codex");
    configuration.maintenance.mode = mode;
    const authority = await inspectGeneratedWorkflow({
      descriptor: WORKFLOW_ASSETS.maintenance,
      configuration,
      render: renderRivetMaintenanceWorkflow,
      binaryPath,
      temporaryParent,
      compileWorkflow,
      validateWorkflow,
      inspectWorkflow,
    });
    const digests = maintenanceAuthorityDigests(authority);
    if (!normalized) {
      normalized = digests;
    } else if (JSON.stringify(digests) !== JSON.stringify(normalized)) {
      throw new Error(
        "manual and scheduled maintenance authority inventories are incompatible",
      );
    }
  }
  return normalized;
}

async function generateRepairInventory({
  binaryPath,
  temporaryParent,
  compileWorkflow,
  validateWorkflow,
  inspectWorkflow,
}) {
  const hashes = {};
  for (const engine of AUTHORITY_ENGINES) {
    const configuration = workflowConfiguration(engine);
    configuration.repair.authority = "owner";
    const authority = await inspectGeneratedWorkflow({
      descriptor: WORKFLOW_ASSETS.repair,
      configuration,
      render: renderRivetRepairWorkflow,
      renderOptions: { validation: REPAIR_VALIDATION_COMMANDS },
      binaryPath,
      temporaryParent,
      compileWorkflow,
      validateWorkflow,
      inspectWorkflow,
    });
    hashes[engine] = repairAuthorityDigest(
      authority,
      REPAIR_VALIDATION_COMMANDS,
    );
  }
  return hashes;
}

// Regenerate from the pinned compiler, never from an untrusted candidate lock.
export async function refreshReviewAuthority({
  write = false,
  ensureBinary = ensureGhAwBinary,
  compileWorkflow = compileGhAwWorkflow,
  validateWorkflow = validateGhAwWorkflow,
  inspectWorkflow = inspectCompiledWorkflow,
  temporaryParent = os.tmpdir(),
  trustPath = TRUST_PATH,
  readTrust = readFile,
  writeTrust = writeFile,
} = {}) {
  const binaryPath = await ensureBinary();
  const original = await readTrust(trustPath, "utf8");
  const [review, issueTriage, maintenance, repair] = await Promise.all([
    generateReviewInventories({
      binaryPath,
      temporaryParent,
      compileWorkflow,
      validateWorkflow,
      inspectWorkflow,
    }),
    generateIssueTriageInventory({
      binaryPath,
      temporaryParent,
      compileWorkflow,
      validateWorkflow,
      inspectWorkflow,
    }),
    generateMaintenanceInventory({
      binaryPath,
      temporaryParent,
      compileWorkflow,
      validateWorkflow,
      inspectWorkflow,
    }),
    generateRepairInventory({
      binaryPath,
      temporaryParent,
      compileWorkflow,
      validateWorkflow,
      inspectWorkflow,
    }),
  ]);
  const updated = replaceAuthorityDeclarations(
    original,
    authorityDeclarations({
      review,
      issueTriage,
      maintenance,
      repair,
    }),
  );
  if (write) await writeTrust(trustPath, updated);
  else if (updated !== original)
    throw new Error(
      "authority inventories differ from pinned compiler output",
    );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--write") || args.length > 1)
    fail("usage: refresh-review-authority.mjs [--write]");
  await refreshReviewAuthority({ write: args.includes("--write") });
  process.stdout.write(
    "Verified Rivet authority inventories for review, issue triage, maintenance, and repair\n",
  );
}
