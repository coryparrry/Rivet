import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import { currentReviewLock } from "./review-lock-fixtures.mjs";

export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const LOCK_PATH = ".github/workflows/rivet-review.lock.yml";
export const REVIEWER_PATH = ".github/rivet/agents/pr-reviewer.md";
export const ISSUE_TRIAGER_PATH = ".github/rivet/agents/issue-triager.md";
export const FIXER_PATH = ".github/rivet/agents/fixer.md";
export const ISSUE_TRIAGE_PATHS = [
  ISSUE_TRIAGER_PATH,
  ".github/rivet/actions/prepare-issue-context/action.yml",
  ".github/rivet/actions/prepare-issue-context/index.mjs",
  ".github/workflows/rivet-issue-triage.md",
  ".github/workflows/rivet-issue-triage.lock.yml",
];
export const REVIEW_EXTENSION_PATH = ".github/rivet/aw/review-extension.md";
export const REVIEW_ASSETS = [
  ".github/rivet/actions/authority-receipt/action.yml",
  ".github/rivet/actions/authority-receipt/index.mjs",
  REVIEW_EXTENSION_PATH,
];
export const REPAIR_ASSETS = [
  ".github/rivet/actions/publish-repair/action.yml",
  ".github/rivet/actions/publish-repair/index.mjs",
  ".github/rivet/actions/validate-repair/action.yml",
  ".github/rivet/actions/validate-repair/index.mjs",
];
export const V012_FIXTURES = path.join(
  PACKAGE_ROOT,
  "test/fixtures/v0.1.2",
);
const MAINTENANCE_FIXTURES = {
  manual: path.join(
    PACKAGE_ROOT,
    "test/fixtures/maintenance/rivet-maintenance-manual.lock.yml.gz.b64",
  ),
  scheduled: path.join(
    PACKAGE_ROOT,
    "test/fixtures/maintenance/rivet-maintenance-scheduled.lock.yml.gz.b64",
  ),
};
export const MAINTENANCE_PATHS = [
  ".github/rivet/agents/repository-auditor.md",
  ".github/rivet/actions/validate-audit/action.yml",
  ".github/rivet/actions/validate-audit/index.mjs",
  ".github/workflows/rivet-maintenance.md",
  ".github/workflows/rivet-maintenance.lock.yml",
];

export async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rivet-install-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export async function frozenV012Lock(workflowId) {
  const encoded = await readFile(
    path.join(V012_FIXTURES, `${workflowId}.lock.yml.gz.b64`),
    "utf8",
  );
  return gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
}

export async function fixtureCompiler({ repositoryRoot, workflowId }) {
  const workflow = await readFile(
    path.join(repositoryRoot, `.github/workflows/${workflowId}.md`),
    "utf8",
  );
  let source;
  if (workflowId === "rivet-issue-triage") {
    source = gunzipSync(
      Buffer.from(
        await readFile(
          path.join(
            PACKAGE_ROOT,
            "test/fixtures/issue-triage/rivet-issue-triage.lock.yml.gz.b64",
          ),
          "utf8",
        ),
        "base64",
      ),
    ).toString("utf8");
  } else if (workflowId === "rivet-maintenance") {
    const fixture = workflow.includes('cron: "17 3 * * 1"')
      ? MAINTENANCE_FIXTURES.scheduled
      : MAINTENANCE_FIXTURES.manual;
    source = gunzipSync(
      Buffer.from(await readFile(fixture, "utf8"), "base64"),
    ).toString("utf8");
  } else if (
    workflowId === "rivet-review" &&
    workflow.includes(REVIEWER_PATH)
  ) {
    source = await currentReviewLock(PACKAGE_ROOT, workflow);
  } else if (workflow.includes(FIXER_PATH)) {
    source = gunzipSync(
      Buffer.from(
        await readFile(
          path.join(
            PACKAGE_ROOT,
            "test/fixtures/repair/rivet-repair.lock.yml.gz.b64",
          ),
          "utf8",
        ),
        "base64",
      ),
    ).toString("utf8");
  } else {
    source = await frozenV012Lock(workflowId);
  }
  await writeFile(
    path.join(repositoryRoot, `.github/workflows/${workflowId}.lock.yml`),
    source,
  );
}

export async function removeIssueTriage(repositoryRoot) {
  for (const relativePath of ISSUE_TRIAGE_PATHS) {
    await rm(path.join(repositoryRoot, relativePath));
  }
  const receiptPath = path.join(
    repositoryRoot,
    ".github/rivet/installation.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.managedFiles = receipt.managedFiles.filter(
    (relativePath) => !ISSUE_TRIAGE_PATHS.includes(relativePath),
  );
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

export async function fixtureValidator() {}

export function countStatus(result, status) {
  return result.files.filter(({ status: fileStatus }) => fileStatus === status)
    .length;
}

async function writeAsset(repositoryRoot, group, relativePath) {
  const destination = path.join(repositoryRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(
    destination,
    await readFile(
      path.join(PACKAGE_ROOT, "assets", group, relativePath),
      "utf8",
    ),
  );
}

export async function writeLegacyInstallation({
  repositoryRoot,
  mode,
  configuration,
}) {
  const expectedConfiguration = structuredClone(DEFAULT_RIVET_CONFIG);
  if (mode === "repair") expectedConfiguration.repair.authority = "owner";
  assert.deepEqual(configuration, expectedConfiguration);
  for (const relativePath of REVIEW_ASSETS) {
    await writeAsset(repositoryRoot, "review", relativePath);
  }
  if (mode === "repair") {
    for (const relativePath of REPAIR_ASSETS) {
      await writeAsset(repositoryRoot, "repair", relativePath);
    }
  }
  await mkdir(path.join(repositoryRoot, ".github/workflows"), {
    recursive: true,
  });
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-review.md"),
    await readFile(path.join(V012_FIXTURES, "rivet-review.md"), "utf8"),
  );
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-review.lock.yml"),
    await frozenV012Lock("rivet-review"),
  );
  if (mode === "repair") {
    await writeFile(
      path.join(repositoryRoot, ".github/workflows/rivet-repair.md"),
      await readFile(path.join(V012_FIXTURES, "rivet-repair.md"), "utf8"),
    );
    await writeFile(
      path.join(repositoryRoot, ".github/workflows/rivet-repair.lock.yml"),
      await frozenV012Lock("rivet-repair"),
    );
  }
  await writeFile(
    path.join(repositoryRoot, ".github/rivet.json"),
    `${JSON.stringify(configuration, null, 2)}\n`,
  );
  await writeFile(
    path.join(repositoryRoot, ".github/rivet/installation.json"),
    await readFile(
      path.join(V012_FIXTURES, `${mode}-installation.json`),
      "utf8",
    ),
  );
}
