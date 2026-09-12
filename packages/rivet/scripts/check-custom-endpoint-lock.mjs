import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import { ensureGhAwBinary } from "../src/gh-aw/binary.mjs";
import {
  prepareRepairInstallation,
  prepareReviewInstallation,
  knownCompilerDrift,
} from "../src/install.mjs";

const FIXTURE_ROOT = new URL(
  "../test/fixtures/custom-endpoints/",
  import.meta.url,
);

export function customEndpointConfiguration() {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.models.review = {
    engine: "codex",
    // Compilation fixture only; this check never calls a provider.
    model: "custom-response-model",
    effort: "default",
    endpoint: {
      baseUrl: "https://models.example.com/gateway/v1/",
      apiKeySecret: "CUSTOM_MODEL_API_KEY",
    },
  };
  return configuration;
}

export async function checkCustomEndpointLocks({ write = false } = {}) {
  const temporaryRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "rivet-endpoint-lock-")),
  );
  try {
    const binaryPath = await ensureGhAwBinary();
    const configuration = customEndpointConfiguration();
    configuration.repair.authority = "owner";
    configuration.maintenance.mode = "scheduled";
    for (const custom of [false, true]) {
      const config = structuredClone(configuration);
      if (!custom) delete config.models.review.endpoint;
      const repositoryRoot = path.join(
        temporaryRoot,
        custom ? "custom" : "baseline",
      );
      await mkdir(repositoryRoot);
      const plan = await prepareRepairInstallation({
        repositoryRoot,
        configuration: config,
        binaryPath,
      });
      for (const file of plan.files.filter(({ path: filePath }) =>
        filePath.endsWith(".lock.yml"),
      )) {
        const name = `${custom ? "custom" : "baseline"}-${path.basename(file.path)}.gz.b64`;
        const fixture = new URL(name, FIXTURE_ROOT);
        if (write) {
          await mkdir(FIXTURE_ROOT, { recursive: true });
          await writeFile(
            fixture,
            `${gzipSync(file.content).toString("base64")}\n`,
          );
        } else {
          const checkedIn = gunzipSync(
            Buffer.from(await readFile(fixture, "utf8"), "base64"),
          ).toString("utf8");
          if (
            checkedIn !== file.content &&
            !knownCompilerDrift(file.path, checkedIn, file.content)
          ) {
            throw new Error(
              `custom-endpoint-lock-check: ${name} differs from the pinned compiler output`,
            );
          }
        }
      }
    }
    // Exercise host de-duplication, root paths and standard secret aliases with
    // the production compiler and installer, in addition to the frozen example.
    for (const [name, baseUrl, apiKeySecret] of [
      ["root", "https://models.example.com", "CODEX_API_KEY"],
      ["existing-host", "https://api.openai.com/v1", "OPENAI_API_KEY"],
    ]) {
      const config = customEndpointConfiguration();
      config.models.review.endpoint = { baseUrl, apiKeySecret };
      config.issues.triage = "disabled";
      const repositoryRoot = path.join(temporaryRoot, name);
      await mkdir(repositoryRoot);
      await prepareReviewInstallation({
        repositoryRoot,
        configuration: config,
        binaryPath,
      });
    }
    return {
      fixtures: 8,
      endpointVariants: 3,
      workflows: ["review", "issue-triage", "maintenance", "repair"],
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--write"))
    throw new Error("Usage: check-custom-endpoint-lock.mjs [--write]");
  console.log(
    JSON.stringify(
      await checkCustomEndpointLocks({ write: args.includes("--write") }),
      null,
      2,
    ),
  );
}
