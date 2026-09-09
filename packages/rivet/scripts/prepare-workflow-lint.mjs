import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { isMap, isScalar, parseDocument } from "yaml";

// GitHub supports queue: max, but actionlint 1.7.12 does not yet parse it.
// Validate that extension, then blank only its YAML pair in a lint-only copy.
// All other text and line numbers are retained for actionlint diagnostics.
// https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
export function workflowLintProjection(source) {
  const document = parseDocument(source);
  if (document.errors.length) throw document.errors[0];
  const scopes = [document.contents];
  const jobs = document.get("jobs", true);
  if (isMap(jobs)) scopes.push(...jobs.items.map(({ value }) => value));
  const characters = source.split("");
  for (const scope of scopes) {
    if (!isMap(scope)) continue;
    const concurrency = scope.get("concurrency", true);
    if (!isMap(concurrency) || !concurrency.has("queue")) continue;
    const queue = concurrency.items.find(({ key }) => key.value === "queue");
    const group = concurrency.get("group", true);
    const cancellation = concurrency.get("cancel-in-progress", true);
    if (
      concurrency.flow ||
      !isScalar(queue.value) ||
      queue.value.value !== "max" ||
      !isScalar(group) ||
      typeof group.value !== "string" ||
      !group.value.trim() ||
      (cancellation !== undefined &&
        (!isScalar(cancellation) || cancellation.value !== false))
    ) {
      throw new Error(
        "workflow lint: queue requires a block mapping, literal max, a group, and cancellation absent or false",
      );
    }
    for (
      let index = queue.key.range[0];
      index < queue.value.range[2];
      index++
    ) {
      if (!/[\r\n]/.test(characters[index])) characters[index] = " ";
    }
  }
  return characters.join("");
}

export async function prepareWorkflowLint(outputDirectory) {
  const fixtureRoot = fileURLToPath(
    new URL("../test/fixtures/", import.meta.url),
  );
  const fixtures = ["review/.github/workflows/rivet-review.lock.yml"];
  for (const directory of [
    "review",
    "issue-triage",
    "maintenance",
    "custom-endpoints",
  ]) {
    for (const name of (
      await readdir(path.join(fixtureRoot, directory))
    ).sort()) {
      if (name.endsWith(".lock.yml.gz.b64"))
        fixtures.push(`${directory}/${name}`);
    }
  }
  await mkdir(outputDirectory, { recursive: true });
  const outputs = [];
  for (const fixture of fixtures) {
    const content = await readFile(path.join(fixtureRoot, fixture), "utf8");
    const source = fixture.endsWith(".b64")
      ? gunzipSync(Buffer.from(content, "base64")).toString("utf8")
      : content;
    const output = path.join(
      outputDirectory,
      fixture.replaceAll("/", "-").replace(/\.gz\.b64$/, ""),
    );
    await writeFile(output, workflowLintProjection(source));
    outputs.push(output);
  }
  return outputs;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const outputDirectory = process.argv[2];
  if (!outputDirectory)
    throw new Error("usage: prepare-workflow-lint.mjs OUTPUT_DIRECTORY");
  const outputs = await prepareWorkflowLint(outputDirectory);
  process.stdout.write(
    `Prepared ${outputs.length} compiled workflows for actionlint\n`,
  );
}
