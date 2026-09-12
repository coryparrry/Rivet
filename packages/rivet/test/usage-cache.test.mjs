import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import {
  applyUsageCachePolicy,
  USAGE_CACHE_SAVE_CONDITION,
} from "../src/gh-aw/usage-cache.mjs";
import {
  knownCompilerDrift,
  knownUsageCacheUpgrade,
} from "../src/workflow-compatibility.mjs";

const fixture = await readFile(
  new URL(
    "./fixtures/review/.github/workflows/rivet-review.lock.yml",
    import.meta.url,
  ),
  "utf8",
);
const original = fixture.replace(USAGE_CACHE_SAVE_CONDITION, "always()");
const lockPath = ".github/workflows/rivet-review.lock.yml";

test("read-only review saves artifacts while writable triggers retain cache saves", () => {
  const adjusted = applyUsageCachePolicy(original);
  const before = parse(original);
  const after = parse(adjusted);
  const save = after.jobs.conclusion.steps.find(
    (step) => step.id === "save-daily-aic-cache",
  );
  assert.equal(save.if, USAGE_CACHE_SAVE_CONDITION);
  for (const event of [
    "pull_request_target",
    "workflow_dispatch",
    "push",
    "schedule",
  ]) {
    for (const failed of [false, true]) {
      const enabled = Function(
        "always",
        "github",
        `return ${save.if}`,
      )(() => true, { event_name: event });
      assert.equal(
        enabled,
        event !== "pull_request_target",
        `${event}, failed=${failed}`,
      );
    }
  }
  assert.equal(
    after.jobs.conclusion.steps.find(
      (step) => step.id === "upload-daily-aic-cache",
    ).if,
    "always()",
  );
  assert.ok(
    after.jobs.activation.steps.some(
      (step) => step.id === "restore-daily-aic-cache-fallback",
    ),
  );
  save.if = "always()";
  assert.deepEqual(after, before);
  assert.equal(applyUsageCachePolicy(adjusted), adjusted);
});

test("workflows without pull_request_target remain byte-identical", () => {
  const writable = original.replace(
    "pull_request_target:",
    "workflow_dispatch:",
  );
  assert.equal(applyUsageCachePolicy(writable), writable);
});

test("unknown compiler cache shapes fail instead of hiding changed behavior", () => {
  for (const altered of [
    original.replace("id: save-daily-aic-cache", "id: renamed-cache"),
    original.replace(
      /(id: save-daily-aic-cache\n\s+if:) always\(\)/,
      "$1 success()",
    ),
    original.replace(
      "uses: actions/cache/save@",
      "uses: untrusted/cache/save@",
    ),
  ])
    assert.throws(() => applyUsageCachePolicy(altered), /Rivet usage cache:/);
});

test("existing installs accept only the cache policy upgrade and still plan an update", () => {
  const adjusted = applyUsageCachePolicy(original);
  assert.equal(knownUsageCacheUpgrade(lockPath, original, adjusted), true);
  assert.equal(knownCompilerDrift(lockPath, original, adjusted), false);
  assert.equal(knownUsageCacheUpgrade(lockPath, adjusted, original), false);
  assert.equal(
    knownUsageCacheUpgrade(
      lockPath,
      original,
      adjusted.replace("permissions:", "unexpected-permissions:"),
    ),
    false,
  );
  assert.equal(knownUsageCacheUpgrade("other.txt", original, adjusted), false);
});
