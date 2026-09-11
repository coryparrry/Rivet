import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const IGNORED_DIRECTORIES = new Set([
  "fixture",
  "fixtures",
  "node_modules",
  "test",
  "tests",
]);

export async function collectSyntaxFiles(root = PACKAGE_ROOT) {
  const files = [];

  async function visit(directory, relativeDirectory = "") {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name))
          await visit(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
        files.push(relativePath);
      }
    }
  }

  await visit(root);
  return files;
}

export function checkSyntax(files, { root = PACKAGE_ROOT } = {}) {
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = result.stderr?.trim();
      throw new Error(
        `syntax-inventory: node --check failed for ${file}${
          detail ? `\n${detail}` : ""
        }`,
      );
    }
  }
  return files.length;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const files = await collectSyntaxFiles();
  const count = checkSyntax(files);
  process.stdout.write(`Syntax checked ${count} modules\n`);
}
