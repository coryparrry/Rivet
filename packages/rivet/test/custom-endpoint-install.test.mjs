import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import {
  applyInstallation,
  prepareRepairInstallation,
  prepareReviewInstallation,
} from "../src/install.mjs";
import { customEndpointConfiguration } from "../scripts/check-custom-endpoint-lock.mjs";
import {
  endpointFixtureCompiler,
  mutateWorkflow,
} from "./custom-endpoint-fixtures.mjs";

async function repository(t) {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "rivet-custom-endpoint-install-"),
  );
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  return {
    repositoryRoot,
    compileWorkflow: endpointFixtureCompiler,
    validateWorkflow: async () => {},
  };
}

for (const previous of [
  "pre-auto-tagging",
  "pre-pending-tag-isolation",
  "pre-pending-tag-output",
]) {
  test(`combines ${previous} upgrade with an endpoint change and preserves edited files`, async (t) => {
    const oldSource = await readFile(
      new URL(`./fixtures/${previous}/rivet-review.md`, import.meta.url),
      "utf8",
    );
    const oldLock = gunzipSync(
      Buffer.from(
        await readFile(
          new URL(
            `./fixtures/${previous}/rivet-review.lock.yml.gz.b64`,
            import.meta.url,
          ),
          "utf8",
        ),
        "base64",
      ),
    ).toString("utf8");
    for (const edited of [null, "md", "lock.yml"]) {
      const options = await repository(t);
      options.compileWorkflow = async (input) => {
        const file = path.join(
          input.repositoryRoot,
          ".github/workflows",
          input.workflowId,
        );
        if (
          input.workflowId === "rivet-review" &&
          (await readFile(`${file}.md`, "utf8")) === oldSource
        )
          await writeFile(`${file}.lock.yml`, oldLock);
        else await endpointFixtureCompiler(input);
      };
      await applyInstallation(await prepareReviewInstallation(options));
      const file = path.join(
        options.repositoryRoot,
        ".github/workflows/rivet-review",
      );
      await writeFile(`${file}.md`, oldSource);
      await writeFile(`${file}.lock.yml`, oldLock);
      if (previous !== "pre-pending-tag-output")
        await writeFile(
          path.join(
            options.repositoryRoot,
            ".github/rivet/aw/review-extension.md",
          ),
          await readFile(
            new URL(
              "../assets/upgrades/pre-pending-tag-isolation/review-extension.md",
              import.meta.url,
            ),
            "utf8",
          ),
        );
      const configuration = customEndpointConfiguration();
      await writeFile(
        path.join(options.repositoryRoot, ".github/rivet.json"),
        `${JSON.stringify(configuration, null, 4)}\n`,
      );
      if (edited) {
        const content = `${await readFile(`${file}.${edited}`, "utf8")}\nUser customization\n`;
        await writeFile(`${file}.${edited}`, content);
        await assert.rejects(
          prepareReviewInstallation({ ...options, configuration }),
          /refusing to overwrite/,
        );
        assert.equal(await readFile(`${file}.${edited}`, "utf8"), content);
      } else {
        await applyInstallation(
          await prepareReviewInstallation({ ...options, configuration }),
        );
        assert.match(
          await readFile(`${file}.lock.yml`, "utf8"),
          /steps\.pending-tags\.outcome/,
        );
        const repeat = await prepareReviewInstallation({
          ...options,
          configuration,
        });
        assert.ok(repeat.files.every(({ status }) => status === "unchanged"));
      }
    }
  });
}

test("installs custom endpoints through all model workflows and remains idempotent", async (t) => {
  const options = await repository(t);
  const configuration = customEndpointConfiguration();
  configuration.repair.authority = "owner";
  configuration.maintenance.mode = "scheduled";
  const plan = await prepareRepairInstallation({ ...options, configuration });
  assert.ok(plan.authority.secrets.includes("CUSTOM_MODEL_API_KEY"));
  assert.ok(!plan.authority.secrets.includes("CODEX_API_KEY"));
  for (const file of plan.files.filter(({ path: name }) =>
    name.endsWith(".lock.yml"),
  )) {
    assert.match(
      file.content,
      /OPENAI_BASE_URL: https:\/\/models.example.com\/gateway\/v1\//,
    );
    assert.match(file.content, /secrets.CUSTOM_MODEL_API_KEY/);
  }
  await applyInstallation(plan);
  const repeat = await prepareRepairInstallation({ ...options, configuration });
  assert.ok(repeat.files.every(({ status }) => status === "unchanged"));
});

test("switches an installed default provider to a custom endpoint and back while preserving config formatting", async (t) => {
  const options = await repository(t);
  await applyInstallation(await prepareReviewInstallation(options));
  const custom = customEndpointConfiguration();
  const file = path.join(options.repositoryRoot, ".github/rivet.json");
  const formattedConfig = `${JSON.stringify(custom, null, 4)}\n`;
  await writeFile(file, formattedConfig);
  const plan = await prepareReviewInstallation({
    ...options,
    configuration: custom,
  });
  assert.equal(
    plan.files.find(({ path: name }) => name === ".github/rivet.json").status,
    "unchanged",
  );
  assert.equal(
    plan.files.find(
      ({ path: name }) => name === ".github/workflows/rivet-review.lock.yml",
    ).status,
    "update",
  );
  await applyInstallation(plan);
  assert.equal(await readFile(file, "utf8"), formattedConfig);
  const standard = structuredClone(DEFAULT_RIVET_CONFIG);
  await writeFile(file, `${JSON.stringify(standard, null, 2)}\n`);
  const restored = await prepareReviewInstallation({
    ...options,
    configuration: standard,
  });
  await applyInstallation(restored);
  assert.ok(!JSON.parse(await readFile(file, "utf8")).models.review.endpoint);
  assert.doesNotMatch(
    await readFile(
      path.join(
        options.repositoryRoot,
        ".github/workflows/rivet-review.lock.yml",
      ),
      "utf8",
    ),
    /CUSTOM_MODEL_API_KEY|models.example.com/,
  );
});

for (const upgrade of ["maintenance", "repair"]) {
  test(`combines a provider change with enabling ${upgrade}`, async (t) => {
    const options = await repository(t);
    await applyInstallation(await prepareReviewInstallation(options));
    const configuration = customEndpointConfiguration();
    const configPath = path.join(options.repositoryRoot, ".github/rivet.json");
    await writeFile(configPath, `${JSON.stringify(configuration, null, 4)}\n`);
    if (upgrade === "maintenance") configuration.maintenance.mode = "scheduled";
    else configuration.repair.authority = "owner";
    const prepare =
      upgrade === "repair"
        ? prepareRepairInstallation
        : prepareReviewInstallation;
    const plan = await prepare({ ...options, configuration });
    await applyInstallation(plan);
    assert.deepEqual(
      JSON.parse(await readFile(configPath, "utf8")),
      configuration,
    );
    const repeat = await prepare({ ...options, configuration });
    assert.ok(repeat.files.every(({ status }) => status === "unchanged"));
  });
}

test("combines a provider change with removing maintenance and preserves edited audit workflows", async (t) => {
  for (const modified of [false, true]) {
    const options = await repository(t);
    const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
    configuration.maintenance.mode = "scheduled";
    await applyInstallation(
      await prepareReviewInstallation({ ...options, configuration }),
    );
    configuration.models.review = customEndpointConfiguration().models.review;
    await writeFile(
      path.join(options.repositoryRoot, ".github/rivet.json"),
      `${JSON.stringify(configuration, null, 4)}\n`,
    );
    const workflow = path.join(
      options.repositoryRoot,
      ".github/workflows/rivet-maintenance.md",
    );
    if (modified)
      await writeFile(
        workflow,
        `${await readFile(workflow, "utf8")}\nUser audit instructions.\n`,
      );
    configuration.maintenance.mode = "disabled";
    const pending = prepareReviewInstallation({ ...options, configuration });
    if (modified) {
      await assert.rejects(
        pending,
        /refusing to delete .*rivet-maintenance.md/,
      );
      assert.match(await readFile(workflow, "utf8"), /User audit instructions/);
    } else {
      await applyInstallation(await pending);
      await assert.rejects(readFile(workflow), { code: "ENOENT" });
      const repeat = await prepareReviewInstallation({
        ...options,
        configuration,
      });
      assert.ok(repeat.files.every(({ status }) => status === "unchanged"));
    }
  }
});

test("refuses to overwrite edited workflows when switching providers", async (t) => {
  const options = await repository(t);
  await applyInstallation(await prepareReviewInstallation(options));
  const file = path.join(
    options.repositoryRoot,
    ".github/workflows/rivet-review.md",
  );
  const modified = `${await readFile(file, "utf8")}\nUser-owned workflow instructions.\n`;
  await writeFile(file, modified);
  await assert.rejects(
    prepareReviewInstallation({
      ...options,
      configuration: customEndpointConfiguration(),
    }),
    /refusing to overwrite/,
  );
  assert.equal(await readFile(file, "utf8"), modified);
});

test("rejects a compromised stock baseline and a redirected custom compilation", async (t) => {
  for (const corruptCustom of [false, true]) {
    const options = await repository(t);
    await assert.rejects(
      prepareReviewInstallation({
        ...options,
        configuration: customEndpointConfiguration(),
        compileWorkflow: async (input) => {
          await endpointFixtureCompiler(input);
          if (input.workflowId !== "rivet-review") return;
          const file = path.join(
            input.repositoryRoot,
            `.github/workflows/${input.workflowId}.lock.yml`,
          );
          const source = await readFile(file, "utf8");
          if (source.includes("CUSTOM_MODEL_API_KEY") !== corruptCustom) return;
          const changed = mutateWorkflow(source, (workflow) => {
            if (corruptCustom)
              workflow.jobs.agent.steps.find(
                (step) => step.id === "agentic_execution",
              ).env.OPENAI_BASE_URL = "https://wrong.example.com/v1";
            else workflow.jobs.agent.permissions.contents = "write";
          });
          await writeFile(file, changed);
        },
      }),
      /not trusted|Rivet custom endpoint/,
    );
  }
});

test("keeps provider keys out of compiler processes", async (t) => {
  const options = await repository(t);
  let compilations = 0;
  await prepareReviewInstallation({
    ...options,
    configuration: customEndpointConfiguration(),
    env: {
      CUSTOM_MODEL_API_KEY: "sensitive-provider-fixture",
      CODEX_API_KEY: "sensitive-default-fixture",
      OPENAI_API_KEY: "sensitive-openai-fixture",
      PATH: process.env.PATH,
    },
    compileWorkflow: async (input) => {
      compilations += 1;
      assert.equal(input.env.CUSTOM_MODEL_API_KEY, undefined);
      assert.equal(input.env.CODEX_API_KEY, undefined);
      assert.equal(input.env.OPENAI_API_KEY, undefined);
      await endpointFixtureCompiler(input);
    },
  });
  assert.equal(compilations, 4);
});
