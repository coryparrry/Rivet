import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkSyntax,
  collectSyntaxFiles,
} from "../scripts/syntax-inventory.mjs";

test("syntax inventory includes first-party source, scripts, and historical upgrades", async () => {
  const files = await collectSyntaxFiles();
  assert(files.includes(path.join("src", "gh-aw", "endpoint-trust.mjs")));
  assert(files.includes(path.join("scripts", "prepare-workflow-lint.mjs")));
  assert(
    files.includes(
      path.join("assets", "upgrades", "v0.1.12", "publish-repair-index.mjs"),
    ),
  );
  assert(!files.some((file) => file.split(path.sep).includes("test")));
  assert(!files.some((file) => file.split(path.sep).includes("node_modules")));
});

test("syntax check rejects an invalid module", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rivet-syntax-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "invalid.mjs");
  await writeFile(file, "export const = invalid;\n");

  assert.throws(
    () => checkSyntax([file]),
    /syntax-inventory: node --check failed.*invalid\.mjs/s,
  );
});
