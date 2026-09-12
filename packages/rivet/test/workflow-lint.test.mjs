import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  prepareWorkflowLint,
  workflowLintProjection,
} from "../scripts/prepare-workflow-lint.mjs";

const execFileAsync = promisify(execFile);
const prepareWorkflowLintPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts/prepare-workflow-lint.mjs",
);

test("lint projection validates queueing and preserves other diagnostics and line positions", () => {
  const source = `name: Example
concurrency:
  group: workflow
  queue: max # supported by GitHub
  cancel-in-progress: false
jobs:
  run:
    concurrency:
      group: job
      queue: max
      typo: preserve-this-error
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ needs.missing.outputs.output }}"
`;
  const projected = workflowLintProjection(source);
  assert.equal(projected.length, source.length);
  assert.equal(projected.split("\n").length, source.split("\n").length);
  assert.match(projected, /typo: preserve-this-error/);
  assert.match(projected, /needs.missing.outputs.output/);
  const original = parse(source);
  delete original.concurrency.queue;
  delete original.jobs.run.concurrency.queue;
  assert.deepEqual(parse(projected), original);
  assert.equal(workflowLintProjection(projected), projected);
});

for (const fields of [
  "group: test\n  queue: all",
  "group: test\n  queue: true",
  "group: test\n  queue: max\n  queue: max",
  "group: test\n  queue: max\n  cancel-in-progress: true",
  "group: test\n  queue: max\n  cancel-in-progress: '${{ true }}'",
  "queue: max",
  "group: 123\n  queue: max",
]) {
  test(`lint rejects invalid queue configuration: ${fields.replaceAll("\n", ";")}`, () => {
    assert.throws(() => workflowLintProjection(`concurrency:\n  ${fields}\n`));
  });
}

test("lint rejects flow queue syntax instead of producing a malformed projection", () => {
  assert.throws(() =>
    workflowLintProjection("concurrency: {group: test, queue: max}\n"),
  );
});

test("lint prepares all current stock and custom endpoint workflow fixtures", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rivet-workflow-lint-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputs = await prepareWorkflowLint(directory);
  assert.equal(outputs.length, 23);
  for (const output of outputs) {
    const document = parse(await readFile(output, "utf8"));
    assert.ok(document.jobs.agent, output);
    assert.equal(document.concurrency?.queue, undefined);
    for (const job of Object.values(document.jobs))
      assert.equal(job.concurrency?.queue, undefined);
  }
});

test("runs the workflow-lint CLI when invoked through a symlink", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rivet-workflow-lint-cli-"),
  );
  try {
    const alias = path.join(directory, "prepare-workflow-lint.mjs");
    const outputDirectory = path.join(directory, "output");
    await symlink(prepareWorkflowLintPath, alias);
    const { stdout } = await execFileAsync(process.execPath, [
      alias,
      outputDirectory,
    ]);
    assert.equal(stdout, "Prepared 23 compiled workflows for actionlint\n");
    assert.ok(
      await readFile(
        path.join(
          outputDirectory,
          "review-.github-workflows-rivet-review.lock.yml",
        ),
        "utf8",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
