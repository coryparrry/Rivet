import { inspectCompiledWorkflow } from "./gh-aw/inspect.mjs";
import { assertCustomEndpointWorkflow } from "./gh-aw/endpoint-trust.mjs";
import {
  assessIssueTriageTrust,
  assessMaintenanceTrust,
  assessPullRequestTargetTrust,
} from "./gh-aw/trust.mjs";
import {
  RIVET_ISSUE_TRIAGE_NATIVE_IMPORTS,
  RIVET_ISSUE_TRIAGE_PUBLISH_SCRIPT,
  RIVET_ISSUE_TRIAGE_WORKFLOW_ID,
} from "./workflows/issue-triage.mjs";
import {
  RIVET_MAINTENANCE_NATIVE_IMPORTS,
  RIVET_MAINTENANCE_WORKFLOW_ID,
} from "./workflows/maintenance.mjs";
import {
  RIVET_REVIEW_NATIVE_IMPORTS,
  RIVET_REVIEW_WORKFLOW_ID,
} from "./workflows/review.mjs";

const REVIEW_LOCAL_ACTIONS = Object.freeze([
  "./.github/rivet/actions/authority-receipt",
  "./.github/rivet/actions/prepare-review-context",
]);

const ISSUE_LOCAL_ACTIONS = Object.freeze([
  "./.github/rivet/actions/prepare-issue-context",
]);

const MAINTENANCE_LOCAL_ACTION = "./.github/rivet/actions/validate-audit";

export function assertInstallationTrust({ files, trustFiles = files, config }) {
  const endpoint = config.models.review.endpoint;
  const trust = assessPullRequestTargetTrust({
    authority: inspectCompiledWorkflow(
      trustFiles.get(`.github/workflows/${RIVET_REVIEW_WORKFLOW_ID}.lock.yml`),
    ),
    expectedEngine: config.models.review.engine,
    expectedImports: RIVET_REVIEW_NATIVE_IMPORTS,
    expectedLocalActions: REVIEW_LOCAL_ACTIONS,
    expectedModel: config.models.review.model,
    expectedMaximumFindings: config.review.maximumFindings,
    expectedIssueTriage:
      config.issues.triage === "automatic" ? "automatic" : "disabled",
  });
  if (!trust.trusted) {
    throw new Error(
      `Rivet installer: compiled review workflow is not trusted: ${trust.violations.join("; ")}`,
    );
  }
  if (config.issues.triage === "automatic") {
    const issueAuthority = inspectCompiledWorkflow(
      trustFiles.get(
        `.github/workflows/${RIVET_ISSUE_TRIAGE_WORKFLOW_ID}.lock.yml`,
      ),
    );
    const issueTrust = assessIssueTriageTrust({
      authority: issueAuthority,
      expectedEngine: config.models.review.engine,
      expectedImports: RIVET_ISSUE_TRIAGE_NATIVE_IMPORTS,
      expectedLocalActions: ISSUE_LOCAL_ACTIONS,
      expectedModel: config.models.review.model,
      expectedPublisherScript: RIVET_ISSUE_TRIAGE_PUBLISH_SCRIPT,
    });
    if (!issueTrust.trusted) {
      throw new Error(
        `Rivet installer: compiled issue triage workflow is not trusted: ${issueTrust.violations.join("; ")}`,
      );
    }
  }
  if (config.maintenance.mode !== "disabled") {
    const maintenanceAuthority = inspectCompiledWorkflow(
      trustFiles.get(
        `.github/workflows/${RIVET_MAINTENANCE_WORKFLOW_ID}.lock.yml`,
      ),
    );
    const maintenanceTrust = assessMaintenanceTrust({
      authority: maintenanceAuthority,
      expectedEngine: config.models.review.engine,
      expectedImports: RIVET_MAINTENANCE_NATIVE_IMPORTS,
      expectedLocalActions: [MAINTENANCE_LOCAL_ACTION],
      expectedModel: config.models.review.model,
      expectedTriggers:
        config.maintenance.mode === "scheduled"
          ? ["schedule", "workflow_dispatch"]
          : ["workflow_dispatch"],
    });
    if (!maintenanceTrust.trusted) {
      throw new Error(
        `Rivet installer: compiled maintenance workflow is not trusted: ${maintenanceTrust.violations.join("; ")}`,
      );
    }
  }
  if (endpoint) {
    for (const [relativePath, source] of files) {
      if (!relativePath.endsWith(".lock.yml")) continue;
      assertCustomEndpointWorkflow({
        source,
        baselineSource: trustFiles.get(relativePath),
        endpoint,
        model: config.models.review.model,
      });
    }
  }
}
