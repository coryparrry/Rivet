import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ACTION_PATH = fileURLToPath(
  new URL(
    "../assets/review/.github/rivet/actions/prepare-review-context/index.mjs",
    import.meta.url,
  ),
);
const LOCK_PATH = new URL(
  "./fixtures/review/.github/workflows/rivet-review.lock.yml",
  import.meta.url,
);

test("oversized comparison exits unsuccessfully without publishing a partial snapshot", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rivet-context-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const eventPath = path.join(root, "event.json");
  const outputPath = path.join(root, "output");
  const preloadPath = path.join(root, "github-fixture.mjs");
  const event = {
    repository: { full_name: "owner/repository" },
    pull_request: {
      number: 7,
      changed_files: 1,
      base: { sha: "a".repeat(40) },
      head: { sha: "b".repeat(40) },
    },
  };
  // One generated workflow patch alone can exceed the real 32-KiB budget.
  const comparison = {
    files: [
      {
        filename: ".github/workflows/review.lock.yml",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: `@@ -1 +1 @@\n-old\n+${"x".repeat(40 * 1024)}`,
      },
    ],
  };
  await writeFile(eventPath, JSON.stringify(event));
  await writeFile(outputPath, "");
  await writeFile(
    preloadPath,
    `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(comparison))}, { status: 200 });\n`,
  );
  const action = spawnSync(
    process.execPath,
    ["--import", preloadPath, ACTION_PATH],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "owner/repository",
        GITHUB_API_URL: "https://api.github.com",
        GITHUB_TOKEN: "fixture-token",
      },
    },
  );
  assert.equal(action.status, 1, action.stderr);
  assert.match(
    action.stderr,
    /::error::Rivet review context: comparison exceeds the 32768-byte review budget/,
  );
  assert.equal(await readFile(outputPath, "utf8"), "");

  const { jobs } = parse(await readFile(LOCK_PATH, "utf8"));
  const status = jobs.review_context_status;
  assert.ok(status, "incomplete context must have a failing status job");
  assert.deepEqual([status.needs].flat(), ["review_context"]);
  assert.equal(
    status.if,
    "always() && needs.review_context.result != 'skipped'",
  );
  assert.deepEqual(status.permissions, {});
  assert.notEqual(status["continue-on-error"], true);
  const step = status.steps.find(
    (item) => item.name === "Require complete review context",
  );
  assert.ok(step);
  assert.notEqual(step["continue-on-error"], true);
  assert.equal(
    step.env.RIVET_CONTEXT_READY,
    "${{ needs.review_context.result == 'success' && needs.review_context.outputs.snapshot != '' }}",
  );
  for (const ready of ["false", "", "true"]) {
    const result = spawnSync("bash", ["-e", "-c", step.run], {
      encoding: "utf8",
      env: { ...process.env, RIVET_CONTEXT_READY: ready },
    });
    assert.equal(result.status, ready === "true" ? 0 : 1, result.stderr);
    if (ready !== "true")
      assert.match(result.stdout, /::error::Rivet review blocked/);
  }
  // The failure status must not prevent the independent pending-label reset.
  assert.equal(jobs.review_tags_pending.needs, "pre_activation");
  assert.ok(
    ![jobs.pre_activation.needs].flat().includes("review_context_status"),
  );
  assert.ok(![jobs.activation.needs].flat().includes("review_context_status"));
  assert.ok([jobs.agent.needs].flat().includes("review_context_status"));
  assert.match(jobs.agent.if, /needs\.review_context\.outputs\.snapshot != ''/);
  assert.match(jobs.safe_outputs.if, /needs\.agent\.result == 'success'/);
  assert.match(
    jobs.publish_review_tags.if,
    /needs\.agent\.result != 'skipped'/,
  );
});

test("compiled review token actions use client-id without the deprecated app-id alias", async () => {
  const { jobs } = parse(await readFile(LOCK_PATH, "utf8"));
  const tokens = Object.values(jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) =>
      step.uses?.startsWith("actions/create-github-app-token@"),
    );
  assert.ok(tokens.length >= 3);
  for (const token of tokens) {
    assert.equal(token.with["client-id"], "${{ vars.RIVET_APP_CLIENT_ID }}");
    assert.ok(!Object.hasOwn(token.with, "app-id"));
    assert.equal(
      token.with["private-key"],
      "${{ secrets.RIVET_APP_PRIVATE_KEY }}",
    );
  }
});
