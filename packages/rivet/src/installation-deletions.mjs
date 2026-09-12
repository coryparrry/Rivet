import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { validateRivetConfig } from "./config.mjs";
import { completeInstallationFiles } from "./installation-receipt.mjs";
import { buildIssueTriageUpgradeBaselines } from "./issue-triage-upgrade.mjs";
import { knownInstallationReceiptUpgrade } from "./workflow-compatibility.mjs";

/**
 * Reconstruct the exact prior issue-triage installation before allowing its
 * managed files to be deleted. Missing paths are intentionally compatible so
 * an interrupted deletion can be resumed safely.
 */
export async function prepareIssueTriageDeletion({
  existingFiles,
  existingPath,
  modelBaseline,
  managedPaths,
  stagingRoot,
  mode,
  config,
  reviewConfiguration,
  validation,
  binaryPath,
  compileWorkflow,
  validateWorkflow,
  env,
}) {
  if (!existingPath) return { baselines: [], deletionFiles: null };

  const matchesIssueTriageFiles = (baseline) =>
    baseline &&
    managedPaths.every((relativePath) => {
      const current = existingFiles.get(relativePath);
      return current === null || current === baseline.get(relativePath);
    });
  const issueTriageBaselines = modelBaseline ? [modelBaseline] : [];
  if (!issueTriageBaselines.some(matchesIssueTriageFiles)) {
    const previousConfig = structuredClone(config);
    previousConfig.issues.triage = "automatic";
    const previousReviewConfig = reviewConfiguration(mode, previousConfig);
    issueTriageBaselines.push(
      ...(await buildIssueTriageUpgradeBaselines({
        stagingRoot: path.join(stagingRoot, "disabled-issue-triage"),
        mode,
        config: previousConfig,
        reviewConfig: previousReviewConfig,
        validation,
        binaryPath,
        compileWorkflow,
        validateWorkflow,
        env,
      })),
    );
  }
  const issueTriageDeletionBaseline = issueTriageBaselines.find(
    matchesIssueTriageFiles,
  );
  if (!issueTriageDeletionBaseline) {
    const changedPath = managedPaths.find(
      (relativePath) =>
        !issueTriageBaselines.some(
          (baseline) =>
            existingFiles.get(relativePath) === baseline.get(relativePath),
        ),
    );
    throw new Error(
      `Rivet installer: refusing to delete ${changedPath ?? existingPath}`,
    );
  }
  return {
    baselines: issueTriageBaselines,
    deletionFiles: new Map(
      managedPaths
        .filter((relativePath) => existingFiles.get(relativePath) !== null)
        .map((relativePath) => [
          relativePath,
          issueTriageDeletionBaseline.get(relativePath),
        ]),
    ),
  };
}

/**
 * Reconstruct a manual or scheduled maintenance installation before allowing
 * its managed files to be deleted. The accepted candidates include both the
 * current configuration and any model-only configuration baseline, which is
 * required when a disable is combined with another configuration change.
 */
export async function prepareMaintenanceDeletion({
  existingFiles,
  existingMaintenanceFiles,
  existingMaintenancePath,
  existingConfigurationContent,
  desiredConfiguration,
  desiredReceipt,
  managedPaths,
  modelBaseline,
  stagingRoot,
  mode,
  config,
  buildVariant,
  variantOptions,
}) {
  const previousMaintenanceMode = (() => {
    if (existingConfigurationContent === null) return undefined;
    try {
      return validateRivetConfig(JSON.parse(existingConfigurationContent))
        .maintenance.mode;
    } catch {
      return undefined;
    }
  })();
  if (
    !["manual", "scheduled"].includes(previousMaintenanceMode) &&
    !existingMaintenancePath
  ) {
    return { baselines: [], deletionFiles: null };
  }

  let existingConfiguration = null;
  if (existingConfigurationContent !== null) {
    try {
      existingConfiguration = validateRivetConfig(
        JSON.parse(existingConfigurationContent),
      );
    } catch {
      existingConfiguration = null;
    }
  }
  if (!existingConfiguration) {
    throw new Error(
      `Rivet installer: refusing to delete ${existingMaintenancePath ?? ".github/rivet.json"}`,
    );
  }
  const previousConfigurations = [];
  const addPreviousConfigurations = (configuration) => {
    if (!configuration) return;
    for (const maintenanceMode of ["manual", "scheduled"]) {
      if (
        configuration.maintenance.mode !== "disabled" &&
        configuration.maintenance.mode !== maintenanceMode
      ) {
        continue;
      }
      const candidate = structuredClone(configuration);
      candidate.maintenance.mode = maintenanceMode;
      if (
        !previousConfigurations.some((entry) =>
          isDeepStrictEqual(entry, candidate),
        )
      ) {
        previousConfigurations.push(candidate);
      }
    }
  };
  addPreviousConfigurations(existingConfiguration);
  if (modelBaseline) {
    try {
      addPreviousConfigurations(
        validateRivetConfig(
          JSON.parse(modelBaseline.get(".github/rivet.json")),
        ),
      );
    } catch {
      // The model baseline remains subject to the normal overwrite checks.
    }
  }
  const previousBaselines = modelBaseline ? [modelBaseline] : [];
  for (const [
    index,
    previousConfiguration,
  ] of previousConfigurations.entries()) {
    previousBaselines.push(
      await buildVariant({
        ...variantOptions,
        stagingRoot: path.join(stagingRoot, `previous-maintenance-${index}`),
        mode,
        config: previousConfiguration,
      }),
    );
  }
  const existingReceipt = existingFiles.get(".github/rivet/installation.json");
  const previousFiles = previousBaselines.find((baseline) => {
    const configurationMatches =
      existingConfigurationContent === desiredConfiguration ||
      existingConfigurationContent === baseline.get(".github/rivet.json");
    const previousReceipt = baseline.get(".github/rivet/installation.json");
    const receiptMatches =
      existingReceipt === desiredReceipt ||
      existingReceipt === previousReceipt ||
      knownInstallationReceiptUpgrade(
        ".github/rivet/installation.json",
        existingReceipt,
        desiredReceipt,
      ) ||
      knownInstallationReceiptUpgrade(
        ".github/rivet/installation.json",
        existingReceipt,
        previousReceipt,
      );
    return (
      configurationMatches &&
      receiptMatches &&
      managedPaths.every((relativePath) => {
        const current = existingMaintenanceFiles.get(relativePath);
        return current === null || current === baseline.get(relativePath);
      })
    );
  });
  if (!previousFiles) {
    if (
      existingConfigurationContent !== desiredConfiguration &&
      !previousBaselines.some(
        (baseline) =>
          existingConfigurationContent === baseline.get(".github/rivet.json"),
      )
    ) {
      throw new Error("Rivet installer: refusing to delete .github/rivet.json");
    }
    if (
      existingReceipt !== desiredReceipt &&
      !previousBaselines.some(
        (baseline) =>
          existingReceipt === baseline.get(".github/rivet/installation.json") ||
          knownInstallationReceiptUpgrade(
            ".github/rivet/installation.json",
            existingReceipt,
            baseline.get(".github/rivet/installation.json"),
          ),
      )
    ) {
      throw new Error(
        "Rivet installer: refusing to delete .github/rivet/installation.json",
      );
    }
    const changedPath = managedPaths.find((relativePath) => {
      const current = existingMaintenanceFiles.get(relativePath);
      return (
        current !== null &&
        !previousBaselines.some(
          (baseline) => current === baseline.get(relativePath),
        )
      );
    });
    throw new Error(
      `Rivet installer: refusing to delete ${changedPath ?? existingMaintenancePath}`,
    );
  }
  const compatiblePreviousFiles = new Map(previousFiles);
  if (existingConfigurationContent === desiredConfiguration) {
    compatiblePreviousFiles.set(
      ".github/rivet.json",
      existingConfigurationContent,
    );
  }
  return {
    baselines: [compatiblePreviousFiles],
    deletionFiles: new Map(
      managedPaths
        .filter(
          (relativePath) => existingMaintenanceFiles.get(relativePath) !== null,
        )
        .map((relativePath) => [relativePath, previousFiles.get(relativePath)]),
    ),
  };
}

/**
 * Build and validate the previous maintenance variant when another upgrade
 * changes the maintenance mode without disabling it.
 */
export async function prepareMaintenanceModeChange({
  requiresUpgrade,
  existingFiles,
  existingConfigurationContent,
  desiredMaintenanceMode,
  managedPaths,
  modelBaseline,
  stagingRoot,
  mode,
  config,
  buildVariant,
  variantOptions,
}) {
  if (
    !requiresUpgrade ||
    desiredMaintenanceMode === "disabled" ||
    existingConfigurationContent === null
  ) {
    return null;
  }
  let existingConfiguration = null;
  try {
    existingConfiguration = validateRivetConfig(
      JSON.parse(existingConfigurationContent),
    );
  } catch {
    existingConfiguration = null;
  }
  const previousMaintenanceMode = existingConfiguration?.maintenance.mode;
  if (
    !["manual", "scheduled"].includes(previousMaintenanceMode) ||
    previousMaintenanceMode === desiredMaintenanceMode
  ) {
    return null;
  }
  const previousConfiguration = structuredClone(config);
  previousConfiguration.maintenance.mode = previousMaintenanceMode;
  const previousFiles =
    modelBaseline ??
    (await buildVariant({
      ...variantOptions,
      stagingRoot: path.join(stagingRoot, "previous-maintenance"),
      mode,
      config: previousConfiguration,
    }));
  if (
    existingConfigurationContent !== previousFiles.get(".github/rivet.json") ||
    existingFiles.get(".github/rivet/installation.json") !==
      previousFiles.get(".github/rivet/installation.json")
  ) {
    throw new Error(
      "Rivet installer: refusing to overwrite .github/rivet.json",
    );
  }
  for (const relativePath of managedPaths) {
    if (existingFiles.get(relativePath) !== previousFiles.get(relativePath)) {
      throw new Error(`Rivet installer: refusing to overwrite ${relativePath}`);
    }
  }
  return previousFiles;
}
