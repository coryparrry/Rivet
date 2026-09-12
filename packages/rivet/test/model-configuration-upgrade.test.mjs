import assert from "node:assert/strict";
import test from "node:test";
import { buildModelConfigurationBaseline } from "../src/model-configuration-upgrade.mjs";

test("treats aliased installed review frontmatter as unrecognized", async () => {
  const previousSource = `---
name: Rivet pull request review
engine: &review_engine codex
model: *review_engine
safe-outputs:
  create-pull-request-review-comment:
    max: 8
---

Review instructions.
`;

  const baseline = await buildModelConfigurationBaseline({ previousSource });

  assert.equal(baseline, null);
});
