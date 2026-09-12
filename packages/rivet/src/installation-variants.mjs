import { completeInstallationFiles } from "./installation-receipt.mjs";
import {
  RIVET_ISSUE_TRIAGE_NATIVE_IMPORTS,
  RIVET_ISSUE_TRIAGE_WORKFLOW_ID,
} from "./workflows/issue-triage.mjs";
import {
  RIVET_MAINTENANCE_NATIVE_IMPORTS,
  RIVET_MAINTENANCE_WORKFLOW_ID,
} from "./workflows/maintenance.mjs";
import {
  RIVET_REPAIR_NATIVE_IMPORTS,
  RIVET_REPAIR_WORKFLOW_ID,
} from "./workflows/repair.mjs";
import {
  ISSUE_CONTEXT_ASSET_PATHS,
  MAINTENANCE_ASSET_PATHS,
  REPAIR_ASSET_PATHS,
  REVIEW_CONTEXT_ASSET_PATHS,
} from "./workflow-files.mjs";

const [ISSUE_TRIAGER_IMPORT] = RIVET_ISSUE_TRIAGE_NATIVE_IMPORTS;
const [FIXER_IMPORT] = RIVET_REPAIR_NATIVE_IMPORTS;

export function withoutIssueTriage(files) {
  return new Map(
    [...files].filter(
      ([relativePath]) =>
        relativePath !== ISSUE_TRIAGER_IMPORT &&
        !ISSUE_CONTEXT_ASSET_PATHS.includes(relativePath) &&
        !relativePath.includes(`/${RIVET_ISSUE_TRIAGE_WORKFLOW_ID}.`),
    ),
  );
}

export function withoutMaintenance(files) {
  return new Map(
    [...files].filter(
      ([relativePath]) =>
        !RIVET_MAINTENANCE_NATIVE_IMPORTS.includes(relativePath) &&
        !MAINTENANCE_ASSET_PATHS.includes(relativePath) &&
        !relativePath.includes(`/${RIVET_MAINTENANCE_WORKFLOW_ID}.`),
    ),
  );
}

export function withoutReviewContext(files) {
  const previous = new Map(files);
  for (const relativePath of REVIEW_CONTEXT_ASSET_PATHS) {
    previous.delete(relativePath);
  }
  return previous;
}

export function reviewOnlyBaseline(files, config) {
  const reviewFiles = new Map(
    [...files].filter(
      ([relativePath]) =>
        !REPAIR_ASSET_PATHS.includes(relativePath) &&
        relativePath !== FIXER_IMPORT &&
        !relativePath.includes(`/${RIVET_REPAIR_WORKFLOW_ID}.`),
    ),
  );
  reviewFiles.delete(".github/rivet/installation.json");
  return completeInstallationFiles(reviewFiles, { mode: "review", config });
}
