import assert from "node:assert/strict";
import test from "node:test";
import { assertCustomEndpointWorkflow } from "../src/gh-aw/endpoint-trust.mjs";
import { customEndpointConfiguration } from "../scripts/check-custom-endpoint-lock.mjs";
import { endpointLock, mutateWorkflow } from "./custom-endpoint-fixtures.mjs";

const { model, endpoint } = customEndpointConfiguration().models.review;
const fixtures = new Map(
  await Promise.all(
    [
      "rivet-review",
      "rivet-issue-triage",
      "rivet-maintenance",
      "rivet-repair",
    ].map(async (id) => [
      id,
      {
        source: await endpointLock(id),
        baselineSource: await endpointLock(id, false),
      },
    ]),
  ),
);

test("accepts the independently compiled endpoint variants for all managed workflows", async () => {
  for (const id of [
    "rivet-review",
    "rivet-issue-triage",
    "rivet-maintenance",
    "rivet-repair",
  ]) {
    assert.doesNotThrow(
      () =>
        assertCustomEndpointWorkflow({
          source: fixtures.get(id).source,
          baselineSource: fixtures.get(id).baselineSource,
          endpoint,
          model,
        }),
      id,
    );
  }
});

for (const jobId of ["agent", "detection"]) {
  test(`rejects endpoint, credential, model and network changes in ${jobId}`, () => {
    const original = fixtures.get("rivet-review");
    const mutations = [
      (step) => {
        step.env.OPENAI_BASE_URL = "https://other.example.com/v1";
      },
      (step) => {
        step.env.CODEX_API_KEY = "${{ secrets.CODEX_API_KEY }}";
      },
      (step) => {
        step.env.OPENAI_API_KEY = "${{ secrets.RIVET_APP_PRIVATE_KEY }}";
      },
      (step) => {
        delete step.env.OPENAI_BASE_URL;
      },
      (step) => {
        step.env[
          jobId === "agent"
            ? "GH_AW_MODEL_AGENT_CODEX"
            : "GH_AW_MODEL_DETECTION_CODEX"
        ] = "different-model";
      },
      (step) => {
        step.run = step.run.replaceAll(
          "models.example.com",
          "other.example.com",
        );
      },
      (step) => {
        step.run = step.run.replace(
          "--openai-api-base-path /gateway/v1",
          "--openai-api-base-path /wrong",
        );
      },
      (step) => {
        step.run = step.run.replace("--exclude-env CODEX_API_KEY", "");
      },
      (step) => {
        step.run += "\necho unexpected-command\n";
      },
    ];
    for (const mutate of mutations) {
      const source = mutateWorkflow(original.source, (workflow) =>
        mutate(
          workflow.jobs[jobId].steps.find((step) =>
            step.id?.endsWith("agentic_execution"),
          ),
        ),
      );
      assert.throws(
        () =>
          assertCustomEndpointWorkflow({
            ...original,
            source,
            endpoint,
            model,
          }),
        /Rivet custom endpoint/,
      );
    }
  });
}

test("rejects authority changes outside the provider configuration", () => {
  const original = fixtures.get("rivet-review");
  for (const mutate of [
    (workflow) => {
      workflow.permissions.contents = "write";
    },
    (workflow) => {
      workflow.jobs.agent.env = {
        RIVET_APP_PRIVATE_KEY: "${{ secrets.RIVET_APP_PRIVATE_KEY }}",
      };
    },
    (workflow) => {
      workflow.jobs.safe_outputs.steps.push({ run: "echo unexpected" });
    },
    (workflow) => {
      workflow.jobs.activation.steps.find(
        (step) => step.id === "generate_aw_info",
      ).env.GH_AW_INFO_ALLOWED_DOMAINS = '["defaults","*"]';
    },
  ]) {
    assert.throws(
      () =>
        assertCustomEndpointWorkflow({
          ...original,
          source: mutateWorkflow(original.source, mutate),
          endpoint,
          model,
        }),
      /Rivet custom endpoint/,
    );
  }
});

test("rejects proxy JSON duplicates and changed shell quoting instead of normalizing away tampering", () => {
  const original = fixtures.get("rivet-review");
  for (const mutate of [
    (run) =>
      run.replace(
        '\\"maxAiCredits\\":${GH_AW_MAX_AI_CREDITS}',
        '\\"maxAiCredits\\":${GH_AW_MAX_AI_CREDITS},\\"maxAiCredits\\":null',
      ),
    (run) => run.replace("\\$schema", "$schema"),
    (run) =>
      run.replace(
        '\\"modelFallback\\":{\\"enabled\\":false}',
        '\\"modelFallback\\":{\\"enabled\\":true}',
      ),
  ]) {
    const source = mutateWorkflow(original.source, (workflow) => {
      const step = workflow.jobs.agent.steps.find(
        (entry) => entry.id === "agentic_execution",
      );
      const changed = mutate(step.run);
      assert.notEqual(changed, step.run);
      step.run = changed;
    });
    assert.throws(
      () =>
        assertCustomEndpointWorkflow({ ...original, source, endpoint, model }),
      /Rivet custom endpoint/,
    );
  }
});
