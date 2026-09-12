import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import { installRepair, installReview } from "../src/install.mjs";
import {
  fixtureCompiler,
  fixtureValidator,
  PACKAGE_ROOT,
} from "./install-test-helpers.mjs";

const execFileAsync = promisify(execFile);
const FIXTURE_ROOT = path.join(PACKAGE_ROOT, "test/fixtures/v0.1.15");

async function releasedInstallation(t, mode) {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), `rivet-v0.1.15-${mode}-`),
  );
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const archivePath = path.join(repositoryRoot, "installation.tar");
  const encoded = await readFile(
    path.join(FIXTURE_ROOT, `${mode}-installation.tar.gz.b64`),
    "utf8",
  );
  await writeFile(
    archivePath,
    gunzipSync(Buffer.from(encoded.replaceAll(/\s/g, ""), "base64")),
  );
  await execFileAsync("tar", ["-xf", archivePath, "-C", repositoryRoot]);
  await rm(archivePath);
  return repositoryRoot;
}

for (const { mode, install, configuration } of [
  {
    mode: "review",
    install: installReview,
    configuration: structuredClone(DEFAULT_RIVET_CONFIG),
  },
  {
    mode: "repair",
    install: installRepair,
    configuration: (() => {
      const value = structuredClone(DEFAULT_RIVET_CONFIG);
      value.repair.authority = "owner";
      return value;
    })(),
  },
]) {
  test(`upgrades an exact released v0.1.15 ${mode} installation`, async (t) => {
    const repositoryRoot = await releasedInstallation(t, mode);
    const options = {
      repositoryRoot,
      configuration,
      compileWorkflow: fixtureCompiler,
      validateWorkflow: fixtureValidator,
    };

    const upgraded = await install(options);
    assert.ok(upgraded.files.some(({ status }) => status === "update"));
    const repeated = await install(options);
    assert.ok(repeated.files.every(({ status }) => status === "unchanged"));
  });
}
