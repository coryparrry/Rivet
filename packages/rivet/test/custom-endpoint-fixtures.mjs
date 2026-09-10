import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { parse, stringify } from "yaml";

export async function endpointLock(workflowId, custom = true) {
  const source = await readFile(
    new URL(
      `./fixtures/custom-endpoints/${custom ? "custom" : "baseline"}-${workflowId}.lock.yml.gz.b64`,
      import.meta.url,
    ),
    "utf8",
  );
  return gunzipSync(Buffer.from(source, "base64")).toString("utf8");
}

export function mutateWorkflow(source, mutate) {
  const workflow = parse(source);
  mutate(workflow);
  const headers = source
    .split("\n")
    .filter((line) => line.startsWith("# gh-aw-"));
  return `${headers.join("\n")}\n${stringify(workflow)}`;
}

export async function endpointFixtureCompiler({ repositoryRoot, workflowId }) {
  const file = path.join(repositoryRoot, ".github", "workflows", workflowId);
  const source = await readFile(`${file}.md`, "utf8");
  const frontmatter = parse(source.match(/^---\n([\s\S]*?)\n---/)[1]);
  let lock;
  if (frontmatter.engine?.env?.OPENAI_BASE_URL) {
    lock = await endpointLock(workflowId);
  } else if (
    frontmatter.model === "custom-response-model" ||
    workflowId === "rivet-repair"
  ) {
    lock = await endpointLock(workflowId, false);
  } else if (workflowId === "rivet-review") {
    lock = await readFile(
      new URL(
        "./fixtures/review/.github/workflows/rivet-review.lock.yml",
        import.meta.url,
      ),
      "utf8",
    );
  } else {
    const fixture =
      workflowId === "rivet-maintenance"
        ? "maintenance/rivet-maintenance-scheduled.lock.yml.gz.b64"
        : "issue-triage/rivet-issue-triage.lock.yml.gz.b64";
    lock = gunzipSync(
      Buffer.from(
        await readFile(
          new URL(`./fixtures/${fixture}`, import.meta.url),
          "utf8",
        ),
        "base64",
      ),
    ).toString("utf8");
  }
  await writeFile(`${file}.lock.yml`, lock);
}
