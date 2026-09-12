import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  checkSyntax,
  collectSyntaxFiles,
} from "../scripts/syntax-inventory.mjs";

const execFileAsync = promisify(execFile);
const syntaxInventoryPath = fileURLToPath(
  new URL("../scripts/syntax-inventory.mjs", import.meta.url),
);

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

test("runs the syntax-inventory CLI when invoked through a symlink", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rivet-syntax-cli-"));
  try {
    const alias = path.join(directory, "syntax-inventory.mjs");
    await symlink(syntaxInventoryPath, alias);
    const { stdout } = await execFileAsync(process.execPath, [alias]);
    assert.match(stdout, /^Syntax checked \d+ modules\n$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
