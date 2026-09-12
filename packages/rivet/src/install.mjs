import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { repairAppAuthority, reviewAppAuthority } from "./app-authority.mjs";
import {
  DEFAULT_RIVET_CONFIG,
  productAuthoritySummary,
  validateRivetConfig,
} from "./config.mjs";
import { compileGhAwWorkflow, validateGhAwWorkflow } from "./gh-aw/compile.mjs";
import { inspectCompiledWorkflow } from "./gh-aw/inspect.mjs";
import { assertInstallationTrust } from "./installation-trust.mjs";
import { applyInstallation, existingFile } from "./installation-apply.mjs";
export { applyInstallation } from "./installation-apply.mjs";
import {
  reviewOnlyBaseline,
  withoutIssueTriage,
  withoutMaintenance,
  withoutReviewContext,
} from "./installation-variants.mjs";
import { completeInstallationFiles } from "./installation-receipt.mjs";
import { buildModelConfigurationBaseline } from "./model-configuration-upgrade.mjs";
import {
  prepareIssueTriageDeletion,
  prepareMaintenanceDeletion,
  prepareMaintenanceModeChange,
} from "./installation-deletions.mjs";
import { buildTaggingUpgradeBaselines } from "./tagging-upgrade.mjs";
import {
  buildIssueTriageUpgradeBaselines,
  matchesHistoricalManagedFile,
  PROFILED_REVIEW_EXTENSIONS,
} from "./issue-triage-upgrade.mjs";
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
import { RIVET_REVIEW_WORKFLOW_ID } from "./workflows/review.mjs";
import {
  buildWorkflowFiles,
  ISSUE_CONTEXT_ASSET_PATHS,
  MAINTENANCE_ASSET_PATHS,
  REPAIR_ASSET_PATHS,
  REVIEW_CONTEXT_ASSET_PATHS,
} from "./workflow-files.mjs";
import {
  knownInstallationReceiptUpgrade,
  knownCompilerDrift,
  knownUsageCacheUpgrade,
  matchesWorkflowBaseline,
} from "./workflow-compatibility.mjs";
export { knownCompilerDrift } from "./workflow-compatibility.mjs";
const V013_REVIEW_EXTENSION = new URL(
  "../assets/upgrades/v0.1.3/review-extension.md",
  import.meta.url,
);
const V012_PUBLISH_REPAIR = new URL(
  "../assets/upgrades/v0.1.12/publish-repair-index.mjs",
  import.meta.url,
);
const V013_PREPARE_REVIEW_CONTEXT = new URL(
  "../assets/upgrades/v0.1.13/prepare-review-context-index.mjs",
  import.meta.url,
);
const ISSUE_TRIAGE_MANAGED_PATHS = Object.freeze([
  RIVET_ISSUE_TRIAGE_NATIVE_IMPORTS[0],
  ...ISSUE_CONTEXT_ASSET_PATHS,
  `.github/workflows/${RIVET_ISSUE_TRIAGE_WORKFLOW_ID}.md`,
  `.github/workflows/${RIVET_ISSUE_TRIAGE_WORKFLOW_ID}.lock.yml`,
]);
const MAINTENANCE_MANAGED_PATHS = Object.freeze([
  RIVET_MAINTENANCE_NATIVE_IMPORTS[0],
  ...MAINTENANCE_ASSET_PATHS,
  `.github/workflows/${RIVET_MAINTENANCE_WORKFLOW_ID}.md`,
  `.github/workflows/${RIVET_MAINTENANCE_WORKFLOW_ID}.lock.yml`,
]);
function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}
function repairConfiguration() {
  return {
    ...structuredClone(DEFAULT_RIVET_CONFIG),
    repair: { authority: "owner" },
  };
}
function reviewConfiguration(mode, config) {
  if (mode !== "repair") return config;
  if (config.repair.authority !== "owner") {
    throw new Error("Rivet installer: repair mode requires owner authority");
  }
  return { ...structuredClone(config), repair: { authority: "never" } };
}
async function buildMaintenanceVariant({
  stagingRoot,
  mode,
  config,
  validation,
  binaryPath,
  compileWorkflow,
  validateWorkflow,
  env,
}) {
  const files = await buildWorkflowFiles({
    stagingRoot,
    mode,
    config,
    reviewConfig: reviewConfiguration(mode, config),
    validation,
    binaryPath,
    compileWorkflow,
    validateWorkflow,
    env,
    profiles: true,
    includeIssueTriage: config.issues.triage === "automatic",
    includeMaintenance: true,
  });
  return completeInstallationFiles(files, { mode, config });
}
async function prepareInstallation({
  mode,
  repositoryRoot,
  binaryPath,
  configuration,
  validation = ["npm test"],
  compileWorkflow = compileGhAwWorkflow,
  validateWorkflow = validateGhAwWorkflow,
  env,
  onProgress,
} = {}) {
  onProgress?.("Preparing Rivet installation");
  const root = path.resolve(repositoryRoot ?? process.cwd());
  const config = validateRivetConfig(configuration);
  if (config.models.review.endpoint) {
    env = { ...(env ?? process.env) };
    delete env[config.models.review.endpoint.apiKeySecret];
    delete env.CODEX_API_KEY;
    delete env.OPENAI_API_KEY;
  }
  const reviewConfig = reviewConfiguration(mode, config);
  const productAuthority = productAuthoritySummary(config);
  const githubApp =
    mode === "repair" ? repairAppAuthority(config) : reviewAppAuthority(config);
  const rootMetadata = await lstat(root).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error("Rivet installer: repository root does not exist");
    }
    throw error;
  });
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Rivet installer: repository root must be a directory");
  }
  const stagingRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), `rivet-${mode}-install-`)),
  );
  try {
    const files = await buildWorkflowFiles({
      stagingRoot: path.join(stagingRoot, "target"),
      mode,
      config,
      reviewConfig,
      validation,
      binaryPath,
      compileWorkflow,
      validateWorkflow,
      env,
      profiles: true,
      includeIssueTriage: config.issues.triage === "automatic",
      includeMaintenance: config.maintenance.mode !== "disabled",
    });
    const authority = inspectCompiledWorkflow(
      files.get(`.github/workflows/${RIVET_REVIEW_WORKFLOW_ID}.lock.yml`),
    );
    const endpoint = config.models.review.endpoint;
    let trustFiles = files;
    if (endpoint) {
      const baselineConfig = structuredClone(config);
      delete baselineConfig.models.review.endpoint;
      trustFiles = await buildWorkflowFiles({
        stagingRoot: path.join(stagingRoot, "endpoint-baseline"),
        mode,
        config: baselineConfig,
        reviewConfig: reviewConfiguration(mode, baselineConfig),
        validation,
        binaryPath,
        compileWorkflow,
        validateWorkflow,
        env,
        profiles: true,
        includeIssueTriage: config.issues.triage === "automatic",
        includeMaintenance: config.maintenance.mode !== "disabled",
      });
    }
    assertInstallationTrust({ files, trustFiles, config, validation });
    completeInstallationFiles(files, { mode, config });
    onProgress?.("Checking existing Rivet installation");
    const baselines = [];
    let issueTriageDeletionFiles = null;
    let maintenanceDeletionFiles = null;
    const existingFiles = new Map(
      await Promise.all(
        [...files].map(async ([relativePath]) => [
          relativePath,
          await existingFile(path.join(root, relativePath)),
        ]),
      ),
    );
    const existingConfigurationContent =
      existingFiles.get(".github/rivet.json");
    const existingIssueTriageFiles =
      config.issues.triage === "disabled"
        ? new Map(
            await Promise.all(
              ISSUE_TRIAGE_MANAGED_PATHS.map(async (relativePath) => [
                relativePath,
                await existingFile(path.join(root, relativePath)),
              ]),
            ),
          )
        : null;
    const existingIssueTriagePath = ISSUE_TRIAGE_MANAGED_PATHS.find(
      (relativePath) =>
        existingIssueTriageFiles?.get(relativePath) !== null &&
        existingIssueTriageFiles?.get(relativePath) !== undefined,
    );
    if (existingConfigurationContent !== null) {
      try {
        if (
          isDeepStrictEqual(
            validateRivetConfig(JSON.parse(existingConfigurationContent)),
            config,
          )
        ) {
          files.set(".github/rivet.json", existingConfigurationContent);
        }
      } catch {
        // A malformed or incompatible file remains subject to the overwrite checks.
      }
    }
    const requiresUpgrade =
      Boolean(existingIssueTriagePath) ||
      [...files].some(
        ([relativePath, content]) =>
          existingFiles.get(relativePath) !== null &&
          existingFiles.get(relativePath) !== content &&
          !knownInstallationReceiptUpgrade(
            relativePath,
            existingFiles.get(relativePath),
            content,
          ) &&
          !knownCompilerDrift(
            relativePath,
            existingFiles.get(relativePath),
            content,
          ),
      );
    let modelBaseline = null;
    if (requiresUpgrade) {
      modelBaseline = await buildModelConfigurationBaseline({
        previousConfigurationContent: existingConfigurationContent,
        previousSource: existingFiles.get(
          `.github/workflows/${RIVET_REVIEW_WORKFLOW_ID}.md`,
        ),
        stagingRoot: path.join(stagingRoot, "previous-model-configuration"),
        mode,
        config,
        validation,
        binaryPath,
        compileWorkflow,
        validateWorkflow,
        env,
      });
      if (modelBaseline) baselines.push(modelBaseline);
    }
    const issueTriageDeletion = await prepareIssueTriageDeletion({
      existingFiles: existingIssueTriageFiles,
      existingPath: existingIssueTriagePath,
      modelBaseline,
      managedPaths: ISSUE_TRIAGE_MANAGED_PATHS,
      stagingRoot,
      mode,
      config,
      reviewConfiguration,
      validation,
      binaryPath,
      compileWorkflow,
      validateWorkflow,
      env,
    });
    issueTriageDeletionFiles = issueTriageDeletion.deletionFiles;
    baselines.push(...issueTriageDeletion.baselines);
    if (config.maintenance.mode === "disabled") {
      const existingMaintenanceFiles = new Map(
        await Promise.all(
          MAINTENANCE_MANAGED_PATHS.map(async (relativePath) => [
            relativePath,
            await existingFile(path.join(root, relativePath)),
          ]),
        ),
      );
      const existingMaintenancePath = MAINTENANCE_MANAGED_PATHS.find(
        (relativePath) => existingMaintenanceFiles.get(relativePath) !== null,
      );
      const existingConfigurationContent =
        existingFiles.get(".github/rivet.json");
      const maintenanceDeletion = await prepareMaintenanceDeletion({
        existingFiles,
        existingMaintenanceFiles,
        existingMaintenancePath,
        existingConfigurationContent,
        desiredConfiguration: files.get(".github/rivet.json"),
        desiredReceipt: files.get(".github/rivet/installation.json"),
        managedPaths: MAINTENANCE_MANAGED_PATHS,
        modelBaseline,
        stagingRoot,
        mode,
        config,
        buildVariant: buildMaintenanceVariant,
        variantOptions: {
          validation,
          binaryPath,
          compileWorkflow,
          validateWorkflow,
          env,
        },
      });
      maintenanceDeletionFiles = maintenanceDeletion.deletionFiles;
      baselines.push(...maintenanceDeletion.baselines);
    }
    const maintenanceModeBaseline = await prepareMaintenanceModeChange({
      requiresUpgrade,
      existingFiles,
      existingConfigurationContent,
      desiredMaintenanceMode: config.maintenance.mode,
      managedPaths: MAINTENANCE_MANAGED_PATHS,
      modelBaseline,
      stagingRoot,
      mode,
      config,
      buildVariant: buildMaintenanceVariant,
      variantOptions: {
        validation,
        binaryPath,
        compileWorkflow,
        validateWorkflow,
        env,
      },
    });
    if (maintenanceModeBaseline) baselines.push(maintenanceModeBaseline);
    let reviewBaseline = null;
    if (requiresUpgrade && mode === "repair") {
      reviewBaseline = reviewOnlyBaseline(files, reviewConfig);
      baselines.push(reviewBaseline);
    }
    if (requiresUpgrade && config.issues.triage === "automatic") {
      const previousFiles = withoutIssueTriage(files);
      previousFiles.delete(".github/rivet/installation.json");
      completeInstallationFiles(previousFiles, { mode, config });
      baselines.push(previousFiles);
      if (mode === "repair") {
        const previousReview = withoutIssueTriage(reviewBaseline);
        previousReview.delete(".github/rivet/installation.json");
        completeInstallationFiles(previousReview, {
          mode: "review",
          config: reviewConfig,
        });
        baselines.push(previousReview);
      }
      baselines.push(
        ...(await buildIssueTriageUpgradeBaselines({
          stagingRoot,
          mode,
          config,
          reviewConfig,
          validation,
          binaryPath,
          compileWorkflow,
          validateWorkflow,
          env,
        })),
      );
    }
    if (requiresUpgrade && config.maintenance.mode !== "disabled") {
      const previousConfig = structuredClone(config);
      previousConfig.maintenance.mode = "disabled";
      const previousFiles = withoutMaintenance(files);
      previousFiles.delete(".github/rivet/installation.json");
      completeInstallationFiles(previousFiles, {
        mode,
        config: previousConfig,
      });
      baselines.push(previousFiles);
      if (mode === "repair") {
        const previousReviewConfig = structuredClone(reviewConfig);
        previousReviewConfig.maintenance.mode = "disabled";
        const previousReview = withoutMaintenance(reviewBaseline);
        previousReview.delete(".github/rivet/installation.json");
        completeInstallationFiles(previousReview, {
          mode: "review",
          config: previousReviewConfig,
        });
        baselines.push(previousReview);
      }
    }
    if (requiresUpgrade) {
      const taggingBaselines = await buildTaggingUpgradeBaselines({
        stagingRoot,
        mode,
        config,
        reviewConfig,
        validation,
        binaryPath,
        compileWorkflow,
        validateWorkflow,
        env,
      });
      for (const previousTagging of taggingBaselines) {
        baselines.push(previousTagging);
        if (mode === "repair") {
          baselines.push(reviewOnlyBaseline(previousTagging, reviewConfig));
        }
      }

      for (const { version, url } of PROFILED_REVIEW_EXTENSIONS) {
        const reviewExtension = await readFile(url, "utf8");
        const profiled = await buildWorkflowFiles({
          stagingRoot: path.join(stagingRoot, `profiled-${version}`),
          mode,
          config,
          reviewConfig,
          validation,
          binaryPath,
          compileWorkflow,
          validateWorkflow,
          env,
          profiles: true,
          includeIssueTriage: config.issues.triage === "automatic",
          includeMaintenance: config.maintenance.mode !== "disabled",
          reviewExtension,
          reviewWorkflowVersion: version,
        });
        const previousProfiled = withoutReviewContext(profiled);
        completeInstallationFiles(previousProfiled, { mode, config });
        baselines.push(previousProfiled);
        if (mode === "repair") {
          const profiledReview = await buildWorkflowFiles({
            stagingRoot: path.join(stagingRoot, `profiled-review-${version}`),
            mode: "review",
            config: reviewConfig,
            reviewConfig,
            validation,
            binaryPath,
            compileWorkflow,
            validateWorkflow,
            env,
            profiles: true,
            includeIssueTriage: reviewConfig.issues.triage === "automatic",
            includeMaintenance: reviewConfig.maintenance.mode !== "disabled",
            reviewExtension,
            reviewWorkflowVersion: version,
          });
          const previousProfiledReview = withoutReviewContext(profiledReview);
          completeInstallationFiles(previousProfiledReview, {
            mode: "review",
            config: reviewConfig,
          });
          baselines.push(previousProfiledReview);
        }
      }

      const profiledV013 = await buildWorkflowFiles({
        stagingRoot: path.join(stagingRoot, "profiled-v0.1.3"),
        mode,
        config,
        reviewConfig,
        validation,
        binaryPath,
        compileWorkflow,
        validateWorkflow,
        env,
        profiles: true,
        includeIssueTriage: config.issues.triage === "automatic",
        includeMaintenance: config.maintenance.mode !== "disabled",
        includeReviewBudget: false,
        reviewExtension: await readFile(V013_REVIEW_EXTENSION, "utf8"),
      });
      const previousProfiledV013 = withoutReviewContext(profiledV013);
      completeInstallationFiles(previousProfiledV013, { mode, config });
      baselines.push(previousProfiledV013);

      const legacyReview = await buildWorkflowFiles({
        stagingRoot: path.join(stagingRoot, "legacy-review"),
        mode: "review",
        config: reviewConfig,
        reviewConfig,
        validation,
        binaryPath,
        compileWorkflow,
        validateWorkflow,
        env,
        profiles: false,
        includeIssueTriage: false,
        includeMaintenance: false,
        reviewExtension: await readFile(V013_REVIEW_EXTENSION, "utf8"),
      });
      const previousLegacyReview = withoutReviewContext(legacyReview);
      completeInstallationFiles(previousLegacyReview, {
        mode: "review",
        config: reviewConfig,
      });
      baselines.push(previousLegacyReview);
    }
    if (requiresUpgrade && mode === "repair") {
      const legacyRepair = await buildWorkflowFiles({
        stagingRoot: path.join(stagingRoot, "legacy-repair"),
        mode: "repair",
        config,
        reviewConfig,
        validation,
        binaryPath,
        compileWorkflow,
        validateWorkflow,
        env,
        profiles: false,
        includeIssueTriage: false,
        includeMaintenance: false,
        reviewExtension: await readFile(V013_REVIEW_EXTENSION, "utf8"),
      });
      const previousLegacyRepair = withoutReviewContext(legacyRepair);
      completeInstallationFiles(previousLegacyRepair, { mode, config });
      baselines.push(previousLegacyRepair);
    }
    if (requiresUpgrade) {
      const relativePath =
        ".github/rivet/actions/prepare-review-context/index.mjs";
      const previousContent = await readFile(
        V013_PREPARE_REVIEW_CONTEXT,
        "utf8",
      );
      const previousFiles = new Map(files);
      previousFiles.set(relativePath, previousContent);
      previousFiles.delete(".github/rivet/installation.json");
      completeInstallationFiles(previousFiles, { mode, config });
      baselines.push(previousFiles);
      for (const baseline of baselines) {
        baseline.set(relativePath, previousContent);
      }
    }
    if (requiresUpgrade && mode === "repair") {
      const relativePath = ".github/rivet/actions/publish-repair/index.mjs";
      const previousContent = await readFile(V012_PUBLISH_REPAIR, "utf8");
      const previousFiles = new Map(files);
      previousFiles.set(relativePath, previousContent);
      previousFiles.delete(".github/rivet/installation.json");
      completeInstallationFiles(previousFiles, { mode, config });
      baselines.push(previousFiles);
      for (const baseline of baselines) {
        if (baseline.has(relativePath))
          baseline.set(relativePath, previousContent);
      }
    }
    const compatibleBaselines = baselines.filter((baseline) =>
      [...files].every(([relativePath, content]) => {
        const current = existingFiles.get(relativePath);
        return (
          current === null ||
          current === content ||
          knownInstallationReceiptUpgrade(relativePath, current, content) ||
          knownCompilerDrift(relativePath, current, content) ||
          knownUsageCacheUpgrade(relativePath, current, content) ||
          matchesHistoricalManagedFile(relativePath, digest(current)) ||
          matchesWorkflowBaseline(relativePath, current, baseline)
        );
      }),
    );
    const plannedFiles = [];
    for (const [relativePath, content] of [...files].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      const current = existingFiles.get(relativePath);
      const canUpgrade =
        current !== null &&
        (knownInstallationReceiptUpgrade(relativePath, current, content) ||
          knownCompilerDrift(relativePath, current, content) ||
          knownUsageCacheUpgrade(relativePath, current, content) ||
          matchesHistoricalManagedFile(relativePath, digest(current)) ||
          compatibleBaselines.some((baseline) =>
            matchesWorkflowBaseline(relativePath, current, baseline),
          ));
      if (current !== null && current !== content && !canUpgrade) {
        throw new Error(
          `Rivet installer: refusing to overwrite ${relativePath}`,
        );
      }
      const unchanged =
        current === content ||
        (current !== null &&
          knownCompilerDrift(relativePath, current, content));
      const plannedContent = unchanged ? current : content;
      plannedFiles.push({
        path: relativePath,
        status: unchanged
          ? "unchanged"
          : current === null
            ? "create"
            : "update",
        previousSha256: current === null ? null : digest(current),
        sha256: digest(plannedContent),
        content: plannedContent,
      });
    }
    for (const [deletionFiles, managedPaths] of [
      [issueTriageDeletionFiles, ISSUE_TRIAGE_MANAGED_PATHS],
      [maintenanceDeletionFiles, MAINTENANCE_MANAGED_PATHS],
    ]) {
      if (!deletionFiles) continue;
      for (const relativePath of managedPaths) {
        if (!deletionFiles.has(relativePath)) continue;
        const current = deletionFiles.get(relativePath);
        plannedFiles.push({
          path: relativePath,
          status: "delete",
          previousSha256: digest(current),
          sha256: null,
          content: null,
        });
      }
    }
    plannedFiles.sort(({ path: left }, { path: right }) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return Object.freeze({
      repositoryRoot: root,
      mode,
      productAuthority,
      githubApp,
      authority,
      files: Object.freeze(plannedFiles),
    });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
export function prepareReviewInstallation(options = {}) {
  return prepareInstallation({
    ...options,
    mode: "review",
    configuration: options.configuration ?? DEFAULT_RIVET_CONFIG,
  });
}
export function prepareRepairInstallation(options = {}) {
  return prepareInstallation({
    ...options,
    mode: "repair",
    configuration: options.configuration ?? repairConfiguration(),
  });
}
async function install(prepare, options) {
  const plan = await prepare(options);
  if (!options.dryRun) await applyInstallation(plan, options);
  return Object.freeze({
    repositoryRoot: plan.repositoryRoot,
    mode: plan.mode,
    dryRun: options.dryRun === true,
    productAuthority: plan.productAuthority,
    githubApp: plan.githubApp,
    files: plan.files.map(({ path: filePath, status, sha256 }) => ({
      path: filePath,
      status,
      sha256,
    })),
  });
}
export function installReview(options = {}) {
  return install(prepareReviewInstallation, options);
}
export function installRepair(options = {}) {
  return install(prepareRepairInstallation, options);
}
