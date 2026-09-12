import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  readPackage,
  tagForVersion,
  validateReleasePackage,
} from "../scripts/release-check.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const releaseCheckPath = fileURLToPath(
  new URL("../scripts/release-check.mjs", import.meta.url),
);
const workflowUrl = new URL(
  "../../../.github/workflows/rivet-release.yml",
  import.meta.url,
);
const checksWorkflowUrl = new URL(
  "../../../.github/workflows/rivet-checks.yml",
  import.meta.url,
);

test("binds public Rivet metadata to its exact release tag", async () => {
  const pkg = await readPackage();
  const tag = tagForVersion(pkg.version);

  assert.deepEqual(validateReleasePackage(pkg, tag), {
    name: "@coryparry/rivet",
    version: pkg.version,
    tag,
  });
  assert.equal(pkg.private, undefined);
  assert.deepEqual(pkg.files, ["assets", "bin", "evals", "src"]);
  assert.equal(pkg.bin["rivet-review-eval"], "evals/review-safe-outputs.mjs");
  assert.equal(pkg.bin["rivet-audit-eval"], "evals/audit-safe-outputs.mjs");
  assert.deepEqual(pkg.repository, {
    type: "git",
    url: "git+https://github.com/coryparrry/Rivet.git",
  });
  assert.deepEqual(pkg.bugs, {
    url: "https://github.com/coryparrry/Rivet/issues",
  });
  assert.equal(pkg.homepage, "https://github.com/coryparrry/Rivet#readme");
});

test("rejects tags that do not exactly match the package version", async () => {
  const pkg = await readPackage();
  assert.throws(
    () => validateReleasePackage(pkg, "rivet-v999.0.0"),
    /must exactly match package version/,
  );
});

test("rejects prerelease packages before they can publish to npm latest", async () => {
  const pkg = await readPackage();
  assert.throws(
    () =>
      validateReleasePackage(
        { ...pkg, version: "0.1.16-rc.1" },
        "rivet-v0.1.16-rc.1",
      ),
    /prerelease versions must not be published to the latest dist-tag/,
  );
});

test("checks the release tag from the command-line entrypoint", async () => {
  const pkg = await readPackage();
  const tag = tagForVersion(pkg.version);
  const { stdout } = await execFileAsync(
    process.execPath,
    [releaseCheckPath, "--tag", tag],
    { cwd: packageRoot },
  );
  assert.equal(stdout, `@coryparry/rivet@${pkg.version} is ready for ${tag}\n`);
});

test("runs the release-check CLI when invoked through a symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rivet-release-cli-"));
  try {
    const alias = join(directory, "release-check.mjs");
    await symlink(releaseCheckPath, alias);
    const pkg = await readPackage();
    const tag = tagForVersion(pkg.version);
    const { stdout } = await execFileAsync(
      process.execPath,
      [alias, "--tag", tag],
      { cwd: packageRoot },
    );
    assert.equal(
      stdout,
      `@coryparry/rivet@${pkg.version} is ready for ${tag}\n`,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("packs the executable and production payload without package tests", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "rivet-pack-"));
  try {
    const pkg = await readPackage();
    await execFileAsync("npm", ["pack", packageRoot, "--ignore-scripts"], {
      cwd: outputDirectory,
      env: {
        ...process.env,
        NPM_CONFIG_CACHE: join(outputDirectory, "npm-cache"),
      },
    });
    const archives = (await readdir(outputDirectory)).filter((entry) =>
      entry.endsWith(".tgz"),
    );
    assert.deepEqual(archives, [`coryparry-rivet-${pkg.version}.tgz`]);
    const archivePath = join(outputDirectory, archives[0]);
    const { stdout } = await execFileAsync("tar", ["-tzf", archivePath], {
      cwd: outputDirectory,
    });
    const paths = new Set(
      stdout
        .trim()
        .split("\n")
        .map((entry) => entry.replace(/^package\//, "")),
    );

    assert(paths.has("bin/rivet.mjs"));
    assert(paths.has("evals/review-safe-outputs.mjs"));
    assert(paths.has("evals/audit-safe-outputs.mjs"));
    assert(
      paths.has(
        "assets/maintenance/.github/rivet/actions/validate-audit/index.mjs",
      ),
    );
    assert(paths.has("README.md"));
    assert([...paths].some((path) => path.startsWith("src/")));
    assert([...paths].some((path) => path.startsWith("assets/")));
    for (const profile of [
      "fixer.md",
      "issue-triager.md",
      "pr-reviewer.md",
      "repository-auditor.md",
    ]) {
      assert(paths.has(`assets/agents/${profile}`));
    }
    assert(![...paths].some((path) => path.startsWith("test/")));
    assert(!paths.has("package-lock.json"));

    const { stdout: readme } = await execFileAsync(
      "tar",
      ["-xOzf", archivePath, "package/README.md"],
      { cwd: outputDirectory },
    );
    assert.match(
      readme,
      /## Quick start[\s\S]*```bash\nnpx @coryparry\/rivet init\n```/,
    );
    assert.ok(
      readme.indexOf("npx @coryparry/rivet init") <
        readme.indexOf("npx @coryparry/rivet app-plan"),
    );
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
});

test("uses a protected tag workflow with OIDC trusted publishing", async () => {
  const workflowSource = await readFile(workflowUrl, "utf8");
  const workflow = parse(workflowSource);
  const publish = workflow.jobs.publish;
  const publishStep = publish.steps.find(
    (step) => step.name === "Publish to npm",
  );

  assert.deepEqual(workflow.on.push.tags, ["rivet-v*"]);
  assert.equal(publish["runs-on"], "ubuntu-latest");
  assert.deepEqual(publish.permissions, {
    contents: "read",
    "id-token": "write",
  });
  assert.equal(publish.environment, "npm");
  assert.equal(
    publishStep?.run,
    "npm publish --provenance --access public --ignore-scripts",
  );
  assert.equal(publishStep?.env, undefined);
  assert(!workflowSource.includes("NODE_AUTH_TOKEN"));
  assert(!workflowSource.includes("NPM_PUBLISH_TOKEN"));
  assert(
    publish.steps.some(
      (step) => step.run === "bash scripts/release-source.sh --verify",
    ),
  );
});

test("runs root gates and manifest tests in the required PR check contexts", async () => {
  const source = await readFile(checksWorkflowUrl, "utf8");
  const workflow = parse(source);
  const checkJob = workflow.jobs["rivet-checks"];
  assert.equal(
    checkJob.steps.find((step) => step.name === "Run repository checks")?.run,
    "npm run check",
  );
  assert.equal(
    checkJob.steps.find((step) => step.name === "Run root manifest tests")?.run,
    "node --test scripts/refresh-release-manifest.test.mjs",
  );
  const policy = JSON.parse(
    await readFile(
      new URL("../../../.github/repository-rules.json", import.meta.url),
      "utf8",
    ),
  );
  const requiredChecks = policy.rulesets
    .find((ruleset) => ruleset.target === "branch")
    .rules.find((rule) => rule.type === "required_status_checks")
    .parameters.required_status_checks.map((check) => check.context);
  assert.deepEqual(requiredChecks, [
    "rivet-checks (22.23.2)",
    "rivet-checks (24.19.0)",
    "actionlint",
  ]);
});

test("keeps compiled workflow lint output in runner temp storage and cleans it", async () => {
  const source = await readFile(checksWorkflowUrl, "utf8");
  assert.match(source, /lint_dir=\"\$RUNNER_TEMP\/rivet-workflow-lint\"/);
  assert.match(
    source,
    /actionlint_flags: -shellcheck= -pyflakes= \$\{\{ runner\.temp \}\}\/rivet-workflow-lint\/\*\.yml/,
  );
  assert.match(source, /run: rm -rf -- \"\$RUNNER_TEMP\/rivet-workflow-lint\"/);
  assert.doesNotMatch(source, /\.rivet-workflow-lint/);
});

test("uses BSD-compatible mktemp templates for source archives", async () => {
  const source = await readFile(
    new URL("../../../scripts/release-source.sh", import.meta.url),
    "utf8",
  );
  const mktempLines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("mktemp "));
  assert.ok(mktempLines.length > 0);
  for (const line of mktempLines) {
    assert.match(line, /XXXXXX[\"')\s]*$/);
  }
});

test("release preparation targets the published Rivet component and version", async () => {
  const root = new URL("../../../", import.meta.url);
  const config = JSON.parse(
    await readFile(new URL("release-please-config.json", root), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(new URL(".release-please-manifest.json", root), "utf8"),
  );
  const pkg = await readPackage();
  assert.deepEqual(Object.keys(config.packages), ["packages/rivet"]);
  const component = config.packages["packages/rivet"];
  assert.equal(component["release-type"], "node");
  assert.equal(component["package-name"], pkg.name);
  assert.equal(manifest["packages/rivet"], pkg.version);
  assert.equal(component["include-component-in-tag"], true);
  assert.equal(component["include-v-in-tag"], true);
  assert.equal(
    `${component.component}${component["tag-separator"]}v${pkg.version}`,
    tagForVersion(pkg.version),
  );
  assert.equal(component["changelog-path"], "/CHANGELOG.md");
});

test("release PR preparation binds to an exact head and keeps PAT credentials ephemeral", async () => {
  const source = await readFile(
    new URL(
      "../../../.github/workflows/rivet-release-please.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const workflow = parse(source);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(Object.keys(workflow.on).sort(), [
    "push",
    "workflow_dispatch",
  ]);
  const job = workflow.jobs["release-please"];
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const checkout = job.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with.token, undefined);
  assert.equal(checkout.with["persist-credentials"], false);
  const release = job.steps.find((step) => step.id === "release-please");
  assert.match(
    release.uses,
    /^googleapis\/release-please-action@[a-f0-9]{40}$/,
  );
  assert.equal(release.with.token, "${{ secrets.RELEASE_PLEASE_TOKEN }}");
  assert.equal(release.with["target-branch"], "main");
  assert.equal(release.with["skip-github-release"], undefined);
  const scripts = job.steps.filter((step) => step.run);
  assert(
    scripts.every(
      (step) =>
        step.if === "steps.release-please.outputs.prs_created == 'true'",
    ),
  );
  assert(
    scripts.some((step) =>
      step.run.includes("refreshManifest(process.env.GITHUB_WORKSPACE)"),
    ),
  );
  const resolveHead = scripts.find((step) => step.run.includes("gh api"));
  assert.equal(resolveHead.id, "release-pr-head");
  assert.equal(
    resolveHead.env.RELEASE_PR,
    "${{ steps.release-please.outputs.pr }}",
  );
  assert.match(
    resolveHead.run,
    /test \"\$head_repository\" = \"\$GITHUB_REPOSITORY\"/,
  );
  assert.match(resolveHead.run, /test \"\$branch\" = \"\$expected_branch\"/);
  assert.ok(resolveHead.run.includes('[[ "$sha" =~ ^[0-9a-f]{40}$ ]]'));
  const checkoutHead = scripts.find((step) =>
    step.run.includes("refs\/heads\/\$RELEASE_PR_BRANCH"),
  );
  assert.match(checkoutHead.run, /git switch --detach \"\$RELEASE_PR_SHA\"/);
  const refresh = scripts.find((step) =>
    step.run.includes("refreshManifest(process.env.GITHUB_WORKSPACE)"),
  );
  assert.equal(
    refresh.env.TRUSTED_MANIFEST_SCRIPT,
    "${{ runner.temp }}/refresh-release-manifest.mjs",
  );
  assert.match(
    refresh.run,
    /pathToFileURL\(process\.env\.TRUSTED_MANIFEST_SCRIPT\)/,
  );
  const push = scripts.find((step) => step.run.includes("git push"));
  assert.match(
    push.run,
    /GIT_CONFIG_KEY_0=http\.https:\/\/github\.com\/\.extraheader/,
  );
  assert.match(push.run, /HEAD:refs\/heads\/\$RELEASE_PR_BRANCH/);
  assert.match(
    source,
    /git show \"\$GITHUB_SHA:scripts\/refresh-release-manifest\.mjs\"/,
  );
  assert.doesNotMatch(source, /persist-credentials: true/);
  assert(!source.includes("npm publish"));
});
