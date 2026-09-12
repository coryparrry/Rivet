import assert from "node:assert/strict";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  applyInstallation,
  installRepair,
  installReview,
  prepareReviewInstallation,
} from "../src/install.mjs";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import {
  countStatus,
  fixtureCompiler,
  fixtureValidator,
  MAINTENANCE_PATHS,
  repository,
} from "./install-test-helpers.mjs";

test("disables maintenance with five exact deletion entries", async (t) => {
  const repositoryRoot = await repository(t);
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.maintenance.mode = "scheduled";
  await installReview({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const unrelatedPath = ".github/workflows/rivet-maintenance.extra.md";
  const unrelatedFile = path.join(repositoryRoot, unrelatedPath);
  await mkdir(path.dirname(unrelatedFile), { recursive: true });
  await writeFile(unrelatedFile, "adopter-owned\n");
  const result = await installReview({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.deepEqual(
    result.files
      .filter(({ status }) => status === "delete")
      .map(({ path: filePath }) => filePath)
      .sort(),
    [...MAINTENANCE_PATHS].sort(),
  );
  assert.equal(
    result.files.filter(({ status }) => status === "delete").length,
    5,
  );
  assert.equal(
    result.files.filter(({ status }) => status === "update").length,
    2,
  );
  for (const relativePath of MAINTENANCE_PATHS) {
    await assert.rejects(access(path.join(repositoryRoot, relativePath)), {
      code: "ENOENT",
    });
  }
  assert.equal(
    await readFile(path.join(repositoryRoot, unrelatedPath), "utf8"),
    "adopter-owned\n",
  );
});
test("finishes disabling maintenance after configuration was written", async (t) => {
  const repositoryRoot = await repository(t);
  const installedConfiguration = structuredClone(DEFAULT_RIVET_CONFIG);
  installedConfiguration.maintenance.mode = "scheduled";
  await installReview({
    repositoryRoot,
    configuration: installedConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const disabledConfiguration = structuredClone(installedConfiguration);
  disabledConfiguration.maintenance.mode = "disabled";
  await writeFile(
    path.join(repositoryRoot, ".github/rivet.json"),
    `${JSON.stringify(disabledConfiguration, null, 2)}\n`,
  );
  await unlink(path.join(repositoryRoot, MAINTENANCE_PATHS[0]));

  const result = await installReview({
    repositoryRoot,
    configuration: disabledConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });

  assert.equal(countStatus(result, "delete"), MAINTENANCE_PATHS.length - 1);
  for (const relativePath of MAINTENANCE_PATHS) {
    await assert.rejects(access(path.join(repositoryRoot, relativePath)), {
      code: "ENOENT",
    });
  }
});
test("disables maintenance while changing review settings", async (t) => {
  const repositoryRoot = await repository(t);
  const installedConfiguration = structuredClone(DEFAULT_RIVET_CONFIG);
  installedConfiguration.maintenance.mode = "manual";
  await installReview({
    repositoryRoot,
    configuration: installedConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const changedConfiguration = structuredClone(installedConfiguration);
  changedConfiguration.maintenance.mode = "disabled";
  changedConfiguration.review.maximumFindings = 3;

  const result = await installReview({
    repositoryRoot,
    configuration: changedConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });

  assert.equal(countStatus(result, "delete"), MAINTENANCE_PATHS.length);
  assert.equal(
    JSON.parse(
      await readFile(path.join(repositoryRoot, ".github/rivet.json"), "utf8"),
    ).review.maximumFindings,
    3,
  );
});
test("refuses a modified maintenance file when disabling", async (t) => {
  const repositoryRoot = await repository(t);
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.maintenance.mode = "manual";
  await installReview({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const modifiedPath = MAINTENANCE_PATHS[2];
  const modifiedFile = path.join(repositoryRoot, modifiedPath);
  const modified = `${await readFile(modifiedFile, "utf8")}modified\n`;
  await writeFile(modifiedFile, modified);
  const configurationPath = path.join(repositoryRoot, ".github/rivet.json");
  const configurationBytes = await readFile(configurationPath, "utf8");
  await assert.rejects(
    installReview({
      repositoryRoot,
      compileWorkflow: fixtureCompiler,
      validateWorkflow: fixtureValidator,
    }),
    new RegExp(`refusing to delete ${modifiedPath.replaceAll("/", "\\/")}`),
  );
  assert.equal(await readFile(modifiedFile, "utf8"), modified);
  assert.equal(await readFile(configurationPath, "utf8"), configurationBytes);
});
test("refuses a maintenance file changed after a disable plan", async (t) => {
  const repositoryRoot = await repository(t);
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.maintenance.mode = "scheduled";
  await installReview({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const plan = await prepareReviewInstallation({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const modifiedPath = MAINTENANCE_PATHS[4];
  const modifiedFile = path.join(repositoryRoot, modifiedPath);
  const modified = `${await readFile(modifiedFile, "utf8")}modified\n`;
  await writeFile(modifiedFile, modified);
  await assert.rejects(applyInstallation(plan), /changed after planning/);
  assert.equal(await readFile(modifiedFile, "utf8"), modified);
  for (const relativePath of MAINTENANCE_PATHS) {
    await access(path.join(repositoryRoot, relativePath));
  }
});
test("transitions and disables maintenance in repair mode", async (t) => {
  const repositoryRoot = await repository(t);
  const manualConfiguration = structuredClone(DEFAULT_RIVET_CONFIG);
  manualConfiguration.repair.authority = "owner";
  manualConfiguration.maintenance.mode = "manual";
  await installRepair({
    repositoryRoot,
    configuration: manualConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const scheduledConfiguration = structuredClone(manualConfiguration);
  scheduledConfiguration.maintenance.mode = "scheduled";
  const scheduledResult = await installRepair({
    repositoryRoot,
    configuration: scheduledConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(
    scheduledResult.files.filter(({ status }) => status === "update").length,
    4,
  );
  const disabledResult = await installRepair({
    repositoryRoot,
    configuration: {
      ...structuredClone(manualConfiguration),
      maintenance: { mode: "disabled" },
    },
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(
    disabledResult.files.filter(({ status }) => status === "delete").length,
    5,
  );
});
