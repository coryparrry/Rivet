import { readFile } from "node:fs/promises";
import path from "node:path";
import { completeInstallationFiles } from "./installation-receipt.mjs";
import { buildWorkflowFiles } from "./workflow-files.mjs";

const PRE_PENDING_TAG_ISOLATION_EXTENSION = new URL(
  "../assets/upgrades/pre-pending-tag-isolation/review-extension.md",
  import.meta.url,
);
export const PRE_REVIEW_STATUS_EXTENSION = new URL(
  "../assets/upgrades/pre-review-status/review-extension.md",
  import.meta.url,
);

export async function buildTaggingUpgradeBaselines({
  stagingRoot,
  ...options
}) {
  const reviewExtension = await readFile(
    PRE_PENDING_TAG_ISOLATION_EXTENSION,
    "utf8",
  );
  const baselines = [];
  for (const includeAutoTagging of [false, true]) {
    const files = await buildWorkflowFiles({
      ...options,
      stagingRoot: path.join(
        stagingRoot,
        includeAutoTagging
          ? "before-pending-tag-isolation"
          : "before-auto-tagging",
      ),
      profiles: true,
      includeIssueTriage: options.config.issues.triage === "automatic",
      includeMaintenance: options.config.maintenance.mode !== "disabled",
      includeAutoTagging,
      includeFailureSafePendingTags: false,
      includePendingTagOutput: false,
      useClientIdInput: false,
      reviewExtension,
    });
    baselines.push(completeInstallationFiles(files, options));
  }
  const beforeOutput = await buildWorkflowFiles({
    ...options,
    stagingRoot: path.join(stagingRoot, "before-pending-tag-output"),
    profiles: true,
    includeIssueTriage: options.config.issues.triage === "automatic",
    includeMaintenance: options.config.maintenance.mode !== "disabled",
    includePendingTagOutput: false,
    useClientIdInput: false,
    reviewExtension: await readFile(PRE_REVIEW_STATUS_EXTENSION, "utf8"),
  });
  baselines.push(completeInstallationFiles(beforeOutput, options));
  const beforeStatus = await buildWorkflowFiles({
    ...options,
    stagingRoot: path.join(stagingRoot, "before-review-status"),
    profiles: true,
    includeIssueTriage: options.config.issues.triage === "automatic",
    includeMaintenance: options.config.maintenance.mode !== "disabled",
    useClientIdInput: false,
    reviewExtension: await readFile(PRE_REVIEW_STATUS_EXTENSION, "utf8"),
  });
  baselines.push(completeInstallationFiles(beforeStatus, options));
  return baselines;
}
