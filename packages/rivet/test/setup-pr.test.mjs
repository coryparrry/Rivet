import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import { prepareReviewInstallation } from "../src/install.mjs";
import {
  createRepairSetupPullRequest,
  createReviewSetupPullRequest,
  repositoryFromGitHubOrigin,
} from "../src/setup-pr.mjs";
import { currentReviewLock } from "./review-lock-fixtures.mjs";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const LOCK_PATH = ".github/workflows/rivet-review.lock.yml";
const REPAIR_LOCK_PATH = ".github/workflows/rivet-repair.lock.yml";
const REPAIR_SETUP_PATHS = [
  ".github/rivet.json",
  ".github/rivet/actions/authority-receipt/action.yml",
  ".github/rivet/actions/authority-receipt/index.mjs",
  ".github/rivet/actions/prepare-issue-context/action.yml",
  ".github/rivet/actions/prepare-issue-context/index.mjs",
  ".github/rivet/actions/prepare-review-context/action.yml",
  ".github/rivet/actions/prepare-review-context/index.mjs",
  ".github/rivet/actions/publish-repair/action.yml",
  ".github/rivet/actions/publish-repair/index.mjs",
  ".github/rivet/actions/validate-repair/action.yml",
  ".github/rivet/actions/validate-repair/index.mjs",
  ".github/rivet/agents/fixer.md",
  ".github/rivet/agents/issue-triager.md",
  ".github/rivet/agents/pr-reviewer.md",
  ".github/rivet/aw/review-extension.md",
  ".github/rivet/installation.json",
  ".github/workflows/rivet-issue-triage.lock.yml",
  ".github/workflows/rivet-issue-triage.md",
  REPAIR_LOCK_PATH,
  ".github/workflows/rivet-repair.md",
  LOCK_PATH,
  ".github/workflows/rivet-review.md",
];

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function fixtureCompiler({ repositoryRoot, workflowId }) {
  if (workflowId === "rivet-issue-triage") {
    const encoded = await readFile(
      path.join(
        PACKAGE_ROOT,
        "test/fixtures/issue-triage/rivet-issue-triage.lock.yml.gz.b64",
      ),
      "utf8",
    );
    await writeFile(
      path.join(
        repositoryRoot,
        ".github/workflows/rivet-issue-triage.lock.yml",
      ),
      gunzipSync(Buffer.from(encoded, "base64")),
    );
    return;
  }
  if (workflowId === "rivet-repair") {
    const encoded = await readFile(
      path.join(
        PACKAGE_ROOT,
        "test/fixtures/repair/rivet-repair.lock.yml.gz.b64",
      ),
      "utf8",
    );
    await writeFile(
      path.join(repositoryRoot, REPAIR_LOCK_PATH),
      gunzipSync(Buffer.from(encoded, "base64")),
    );
    return;
  }
  const workflow = await readFile(
    path.join(repositoryRoot, ".github/workflows/rivet-review.md"),
    "utf8",
  );
  const source = await currentReviewLock(PACKAGE_ROOT, workflow);
  await writeFile(path.join(repositoryRoot, LOCK_PATH), source);
}

async function repository(t) {
  const container = await mkdtemp(
    path.join(os.tmpdir(), "rivet-setup-pr-test-"),
  );
  const root = path.join(container, "repository");
  const remote = path.join(container, "remote.git");
  t.after(() => rm(container, { recursive: true, force: true }));
  await git(container, ["init", "--bare", "--initial-branch=main", remote]);
  await git(container, ["init", "--initial-branch=main", root]);
  await git(root, ["config", "user.name", "Rivet Test"]);
  await git(root, ["config", "user.email", "rivet@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial fixture"]);
  await git(root, ["remote", "add", "origin", remote]);
  await git(root, ["push", "-u", "origin", "main"]);
  return { root, remote };
}

function runner(
  calls,
  {
    fail,
    beforeRun,
    pullRequestList,
    pullRequestUrl,
    pullRequestView,
    setupBranch = "rivet/setup-test",
  } = {},
) {
  return async (command, args, { cwd }) => {
    calls.push([command, args]);
    await beforeRun?.({ command, args, cwd });
    const failure = fail?.({ command, args, cwd });
    if (failure) throw new Error(failure);
    if (command === "gh" && args[0] === "repo") {
      return JSON.stringify({
        nameWithOwner: "acme/example",
        defaultBranchRef: { name: "main" },
      });
    }
    if (command === "git" && args[0] === "remote") {
      return "https://github.com/acme/example.git";
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      return pullRequestUrl ?? "https://github.com/acme/example/pull/17";
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      return JSON.stringify(
        pullRequestView ?? {
          baseRefName: "main",
          headRefName: setupBranch,
          headRefOid: await git(cwd, ["rev-parse", "HEAD"]),
          isDraft: true,
          state: "OPEN",
          url: "https://github.com/acme/example/pull/17",
        },
      );
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      if (pullRequestList === "exact") {
        return JSON.stringify([
          {
            baseRefName: "main",
            headRefName: setupBranch,
            headRefOid: await git(cwd, ["rev-parse", setupBranch]),
            isDraft: true,
            state: "OPEN",
            title: `chore: set up Rivet ${
              setupBranch === "rivet/setup-repair" ? "repair" : "review"
            }`,
            url: "https://github.com/acme/example/pull/17",
          },
        ]);
      }
      return JSON.stringify(pullRequestList ?? []);
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "close") {
      return "";
    }
    return git(cwd, args);
  };
}

test("accepts only exact github.com origin identities", () => {
  for (const remote of [
    "https://github.com/acme/example.git",
    "ssh://git@github.com/acme/example.git",
    "git@github.com:acme/example.git",
  ]) {
    assert.equal(repositoryFromGitHubOrigin(remote), "acme/example");
  }
  for (const remote of [
    "https://github.example/acme/example.git",
    "https://token@github.com/acme/example.git",
    "git@github.com:acme/../example.git",
    "/tmp/example.git",
  ]) {
    assert.throws(
      () => repositoryFromGitHubOrigin(remote),
      /origin must be an exact github\.com repository URL/,
    );
  }
});

test("creates a verified draft setup pull request without merging", async (t) => {
  const { root, remote } = await repository(t);
  const calls = [];
  const progress = [];
  const result = await createReviewSetupPullRequest({
    repositoryRoot: root,
    branch: "rivet/setup-test",
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
    run: runner(calls),
    onProgress: (message) => progress.push(message),
  });

  assert.equal(result.repository, "acme/example");
  assert.equal(result.defaultBranch, "main");
  assert.equal(result.branch, "rivet/setup-test");
  assert.match(result.commit, /^[0-9a-f]{40}$/);
  assert.equal(
    result.pullRequestUrl,
    "https://github.com/acme/example/pull/17",
  );
  assert.deepEqual(progress, [
    "Preparing Rivet installation",
    "Checking existing Rivet installation",
    "Creating Rivet setup pull request",
    "Writing Rivet installation",
  ]);
  assert.equal(
    await git(root, ["branch", "--show-current"]),
    "rivet/setup-test",
  );
  assert.equal(
    await git(root, ["rev-parse", "HEAD^"]),
    await git(root, ["rev-parse", "origin/main"]),
  );
  assert.equal(
    await git(remote, ["rev-parse", "refs/heads/rivet/setup-test"]),
    result.commit,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(root, ".github/rivet.json"), "utf8"))
      .repair.authority,
    "never",
  );

  const pullRequestCall = calls.find(
    ([command, args]) =>
      command === "gh" && args[0] === "pr" && args[1] === "create",
  );
  assert.ok(pullRequestCall[1].includes("--draft"));
  assert.ok(!pullRequestCall[1].includes("merge"));
  assert.match(
    pullRequestCall[1][pullRequestCall[1].indexOf("--body") + 1],
    /Merge is impossible/,
  );
  assert.match(
    pullRequestCall[1][pullRequestCall[1].indexOf("--body") + 1],
    /workflows selected in the configuration/,
  );
});

test("creates a verified draft repair setup pull request with repair mode", async (t) => {
  const { root, remote } = await repository(t);
  const calls = [];
  const progress = [];
  const compiledWorkflowIds = [];
  const result = await createRepairSetupPullRequest({
    repositoryRoot: root,
    compileWorkflow: async (options) => {
      compiledWorkflowIds.push(options.workflowId);
      await fixtureCompiler(options);
    },
    validateWorkflow: async () => {},
    run: runner(calls, { setupBranch: "rivet/setup-repair" }),
    onProgress: (message) => progress.push(message),
  });

  assert.equal(result.repository, "acme/example");
  assert.equal(result.defaultBranch, "main");
  assert.equal(result.branch, "rivet/setup-repair");
  assert.match(result.commit, /^[0-9a-f]{40}$/);
  assert.equal(
    result.pullRequestUrl,
    "https://github.com/acme/example/pull/17",
  );
  assert.deepEqual(compiledWorkflowIds, [
    "rivet-review",
    "rivet-issue-triage",
    "rivet-repair",
  ]);
  assert.deepEqual(progress, [
    "Preparing Rivet installation",
    "Checking existing Rivet installation",
    "Creating Rivet setup pull request",
    "Writing Rivet installation",
  ]);

  assert.equal(
    await git(root, ["branch", "--show-current"]),
    "rivet/setup-repair",
  );
  assert.equal(
    await git(root, ["rev-parse", "HEAD^"]),
    await git(root, ["rev-parse", "origin/main"]),
  );
  assert.equal(
    await git(remote, ["rev-parse", "refs/heads/rivet/setup-repair"]),
    result.commit,
  );

  const expectedPaths = [...REPAIR_SETUP_PATHS].sort();
  const committedPaths = (
    await git(root, ["ls-tree", "-r", "--name-only", result.commit])
  )
    .split("\n")
    .filter((filePath) => filePath && filePath !== "README.md")
    .sort();
  assert.deepEqual(committedPaths, expectedPaths);

  const configuration = JSON.parse(
    await readFile(path.join(root, ".github/rivet.json"), "utf8"),
  );
  assert.equal(configuration.repair.authority, "owner");
  const receipt = JSON.parse(
    await readFile(path.join(root, ".github/rivet/installation.json"), "utf8"),
  );
  assert.equal(receipt.mode, "repair");
  assert.deepEqual(receipt.managedFiles, expectedPaths);
  assert.match(
    await readFile(
      path.join(root, ".github/workflows/rivet-repair.md"),
      "utf8",
    ),
    /name: Rivet pull request repair/,
  );

  const pullRequestCall = calls.find(
    ([command, args]) =>
      command === "gh" && args[0] === "pr" && args[1] === "create",
  );
  assert.ok(pullRequestCall);
  assert.equal(
    pullRequestCall[1][pullRequestCall[1].indexOf("--head") + 1],
    "rivet/setup-repair",
  );
  assert.equal(
    pullRequestCall[1][pullRequestCall[1].indexOf("--title") + 1],
    "chore: set up Rivet repair",
  );
  const body = pullRequestCall[1][pullRequestCall[1].indexOf("--body") + 1];
  assert.match(body, /Repair requires an owner action/);
  assert.deepEqual(
    [...body.matchAll(/^- `([^`]+)`$/gm)].map(([, filePath]) => filePath),
    expectedPaths,
  );
});

test("cleans up after pull-request creation fails immediately after push", async (t) => {
  const { root, remote } = await repository(t);
  const calls = [];
  let failed = false;
  await assert.rejects(
    createReviewSetupPullRequest({
      repositoryRoot: root,
      branch: "rivet/setup-test",
      compileWorkflow: fixtureCompiler,
      validateWorkflow: async () => {},
      run: runner(calls, {
        fail: ({ command, args }) => {
          if (
            !failed &&
            command === "gh" &&
            args[0] === "pr" &&
            args[1] === "create"
          ) {
            failed = true;
            return "gh pr create failed";
          }
          return null;
        },
      }),
    }),
    /gh pr create failed/,
  );

  assert.equal(await git(root, ["branch", "--show-current"]), "main");
  assert.equal(await git(root, ["branch", "--list", "rivet/setup-test"]), "");
  assert.equal(
    await git(remote, [
      "for-each-ref",
      "--format=%(objectname)",
      "refs/heads/rivet/setup-test",
    ]),
    "",
  );
  assert.ok(
    calls.some(
      ([command, args]) =>
        command === "git" &&
        args[0] === "push" &&
        args.at(-1) === ":refs/heads/rivet/setup-test",
    ),
  );
});

test("discovers and closes a pull request accepted before create fails", async (t) => {
  const { root } = await repository(t);
  const calls = [];
  await assert.rejects(
    createReviewSetupPullRequest({
      repositoryRoot: root,
      branch: "rivet/setup-test",
      compileWorkflow: fixtureCompiler,
      validateWorkflow: async () => {},
      run: runner(calls, {
        pullRequestList: "exact",
        fail: ({ command, args }) =>
          command === "gh" && args[0] === "pr" && args[1] === "create"
            ? "connection reset after create"
            : null,
      }),
    }),
    /connection reset after create/,
  );
  assert.ok(
    calls.some(
      ([command, args]) =>
        command === "gh" && args[0] === "pr" && args[1] === "list",
    ),
  );
  assert.ok(
    calls.some(
      ([command, args]) =>
        command === "gh" && args[0] === "pr" && args[1] === "close",
    ),
  );
});

test("cleans up after an invalid pull-request URL and permits retry", async (t) => {
  const { root, remote } = await repository(t);
  const firstCalls = [];
  await assert.rejects(
    createReviewSetupPullRequest({
      repositoryRoot: root,
      branch: "rivet/setup-test",
      compileWorkflow: fixtureCompiler,
      validateWorkflow: async () => {},
      run: runner(firstCalls, { pullRequestUrl: "not-a-pull-request" }),
    }),
    /invalid pull-request URL/,
  );
  assert.equal(await git(root, ["branch", "--show-current"]), "main");
  assert.equal(await git(root, ["branch", "--list", "rivet/setup-test"]), "");
  assert.equal(
    await git(remote, [
      "for-each-ref",
      "--format=%(objectname)",
      "refs/heads/rivet/setup-test",
    ]),
    "",
  );

  const result = await createReviewSetupPullRequest({
    repositoryRoot: root,
    branch: "rivet/setup-test",
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
    run: runner([], {}),
  });
  assert.equal(result.branch, "rivet/setup-test");
});

test("cleans up after pull-request verification fails", async (t) => {
  const { root, remote } = await repository(t);
  const calls = [];
  await assert.rejects(
    createReviewSetupPullRequest({
      repositoryRoot: root,
      branch: "rivet/setup-test",
      compileWorkflow: fixtureCompiler,
      validateWorkflow: async () => {},
      run: runner(calls, {
        pullRequestView: {
          baseRefName: "main",
          headRefName: "rivet/setup-test",
          headRefOid: "0".repeat(40),
          isDraft: true,
          state: "OPEN",
          url: "https://github.com/acme/example/pull/17",
        },
      }),
    }),
    /setup pull request does not match the verified plan/,
  );
  assert.equal(await git(root, ["branch", "--show-current"]), "main");
  assert.equal(await git(root, ["branch", "--list", "rivet/setup-test"]), "");
  assert.equal(
    await git(remote, [
      "for-each-ref",
      "--format=%(objectname)",
      "refs/heads/rivet/setup-test",
    ]),
    "",
  );
  assert.ok(
    calls.some(
      ([command, args]) =>
        command === "gh" && args[0] === "pr" && args[1] === "view",
    ),
  );
  assert.ok(
    calls.some(
      ([command, args]) =>
        command === "gh" && args[0] === "pr" && args[1] === "close",
    ),
  );
});

test("restores a detached checkout after a pre-push failure", async (t) => {
  const { root } = await repository(t);
  const originalHead = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["switch", "--detach", originalHead]);
  const calls = [];
  let failed = false;

  await assert.rejects(
    createReviewSetupPullRequest({
      repositoryRoot: root,
      branch: "rivet/setup-test",
      compileWorkflow: fixtureCompiler,
      validateWorkflow: async () => {},
      run: runner(calls, {
        fail: ({ command, args }) => {
          if (
            !failed &&
            command === "git" &&
            args[0] === "diff" &&
            args[1] === "--cached" &&
            args[2] === "--check"
          ) {
            failed = true;
            return "staged diff check failed";
          }
          return null;
        },
      }),
    }),
    /staged diff check failed/,
  );

  assert.equal(await git(root, ["branch", "--show-current"]), "");
  assert.equal(await git(root, ["rev-parse", "HEAD"]), originalHead);
  assert.equal(await git(root, ["status", "--porcelain=v1"]), "");
  assert.equal(await git(root, ["branch", "--list", "rivet/setup-test"]), "");
});

test("removes its local branch after a post-commit check fails", async (t) => {
  const { root } = await repository(t);
  const calls = [];
  let failed = false;
  await assert.rejects(
    createReviewSetupPullRequest({
      repositoryRoot: root,
      branch: "rivet/setup-test",
      compileWorkflow: fixtureCompiler,
      validateWorkflow: async () => {},
      run: runner(calls, {
        fail: ({ command, args }) => {
          if (
            !failed &&
            command === "git" &&
            args[0] === "rev-parse" &&
            args[1].endsWith("^")
          ) {
            failed = true;
            return "parent check failed";
          }
          return null;
        },
      }),
    }),
    /parent check failed/,
  );
  assert.equal(await git(root, ["branch", "--show-current"]), "main");
  assert.equal(await git(root, ["branch", "--list", "rivet/setup-test"]), "");
  assert.equal(await git(root, ["status", "--porcelain=v1"]), "");
});

test("preserves an unverified local branch after commit identity lookup fails", async (t) => {
  const { root } = await repository(t);
  const calls = [];
  let replaced = false;
  let setupCommit = null;
  await assert.rejects(
    createReviewSetupPullRequest({
      repositoryRoot: root,
      branch: "rivet/setup-test",
      compileWorkflow: fixtureCompiler,
      validateWorkflow: async () => {},
      run: runner(calls, {
        fail: ({ command, args }) =>
          command === "git" &&
          args[0] === "rev-parse" &&
          args[1] === "HEAD" &&
          calls.some(
            ([seenCommand, seenArgs]) =>
              seenCommand === "git" && seenArgs[0] === "commit",
          )
            ? "commit identity unavailable"
            : null,
        beforeRun: async ({ command, args, cwd }) => {
          if (
            command === "git" &&
            args[0] === "rev-parse" &&
            args[1] === "HEAD" &&
            calls.some(
              ([seenCommand, seenArgs]) =>
                seenCommand === "git" && seenArgs[0] === "commit",
            )
          ) {
            setupCommit = await git(cwd, ["rev-parse", "HEAD"]);
          }
          if (
            !replaced &&
            command === "git" &&
            args[0] === "for-each-ref" &&
            args.at(-1) === "refs/heads/rivet/setup-test"
          ) {
            replaced = true;
            const base = await git(cwd, ["rev-parse", "main"]);
            const tree = await git(cwd, ["rev-parse", `${setupCommit}^{tree}`]);
            const replacement = await git(cwd, [
              "commit-tree",
              tree,
              "-p",
              base,
              "-m",
              "Concurrent replacement",
            ]);
            await git(cwd, [
              "update-ref",
              "refs/heads/rivet/setup-test",
              replacement,
            ]);
          }
        },
      }),
    }),
    /commit identity unavailable.*local setup branch rivet\/setup-test was not deleted/s,
  );
  assert.notEqual(
    await git(root, ["branch", "--list", "rivet/setup-test"]),
    "",
  );
});

test("does not delete a setup branch that advanced remotely", async (t) => {
  const { root, remote } = await repository(t);
  const advanced = await git(root, ["rev-parse", "origin/main"]);
  const calls = [];
  let branchLookups = 0;
  await assert.rejects(
    createReviewSetupPullRequest({
      repositoryRoot: root,
      branch: "rivet/setup-test",
      compileWorkflow: fixtureCompiler,
      validateWorkflow: async () => {},
      run: runner(calls, {
        pullRequestView: {
          baseRefName: "main",
          headRefName: "rivet/setup-test",
          headRefOid: "0".repeat(40),
          isDraft: true,
          state: "OPEN",
          url: "https://github.com/acme/example/pull/17",
        },
        beforeRun: async ({ command, args }) => {
          if (
            command === "git" &&
            args[0] === "ls-remote" &&
            args.at(-1) === "refs/heads/rivet/setup-test"
          ) {
            branchLookups += 1;
            if (branchLookups === 3) {
              await git(remote, [
                "update-ref",
                "refs/heads/rivet/setup-test",
                advanced,
              ]);
            }
          }
        },
      }),
    }),
    /remote setup branch rivet\/setup-test was not deleted/,
  );
  assert.equal(
    await git(remote, ["rev-parse", "refs/heads/rivet/setup-test"]),
    advanced,
  );
  assert.equal(await git(root, ["branch", "--show-current"]), "main");
  assert.equal(await git(root, ["branch", "--list", "rivet/setup-test"]), "");
  assert.equal(
    calls.filter(
      ([command, args]) =>
        command === "git" &&
        args[0] === "push" &&
        args.at(-1) === ":refs/heads/rivet/setup-test",
    ).length,
    0,
  );
});

test("reports cleanup failure without hiding the setup error", async (t) => {
  const { root, remote } = await repository(t);
  const calls = [];
  await assert.rejects(
    createReviewSetupPullRequest({
      repositoryRoot: root,
      branch: "rivet/setup-test",
      compileWorkflow: fixtureCompiler,
      validateWorkflow: async () => {},
      run: runner(calls, {
        pullRequestView: {
          baseRefName: "main",
          headRefName: "rivet/setup-test",
          headRefOid: "0".repeat(40),
          isDraft: true,
          state: "OPEN",
          url: "https://github.com/acme/example/pull/17",
        },
        fail: ({ command, args }) =>
          command === "git" &&
          args[0] === "push" &&
          args.at(-1) === ":refs/heads/rivet/setup-test"
            ? "remote deletion denied"
            : null,
      }),
    }),
    (error) => {
      assert.match(
        error.message,
        /setup pull request does not match the verified plan/,
      );
      assert.match(
        error.message,
        /could not clean up remote .*remote deletion denied/,
      );
      assert.equal(
        error.cause?.message,
        "Rivet installer: setup pull request does not match the verified plan",
      );
      return true;
    },
  );
  assert.equal(await git(root, ["branch", "--show-current"]), "main");
  assert.equal(await git(root, ["branch", "--list", "rivet/setup-test"]), "");
  assert.notEqual(
    await git(remote, [
      "for-each-ref",
      "--format=%(objectname)",
      "refs/heads/rivet/setup-test",
    ]),
    "",
  );
});

test("reuses a prepared review plan without compiling it again", async (t) => {
  const { root } = await repository(t);
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.issues.triage = "disabled";
  let compileCalls = 0;
  const preparedPlan = await prepareReviewInstallation({
    repositoryRoot: root,
    configuration,
    compileWorkflow: async (options) => {
      compileCalls += 1;
      await fixtureCompiler(options);
    },
    validateWorkflow: async () => {},
  });

  const calls = [];
  const result = await createReviewSetupPullRequest({
    preparedPlan,
    branch: "rivet/setup-test",
    compileWorkflow: async () => {
      throw new Error("prepared plan should not be compiled again");
    },
    validateWorkflow: async () => {},
    run: runner(calls),
  });

  const pullRequestCall = calls.find(
    ([command, args]) =>
      command === "gh" && args[0] === "pr" && args[1] === "create",
  );
  assert.equal(compileCalls, 1);
  assert.equal(result.branch, "rivet/setup-test");
  assert.doesNotMatch(
    pullRequestCall[1][pullRequestCall[1].indexOf("--body") + 1],
    /issue-triage workflows/,
  );
});

const SETUP_FACTORIES = [
  {
    mode: "review",
    factory: createReviewSetupPullRequest,
    branch: "rivet/setup-review",
  },
  {
    mode: "repair",
    factory: createRepairSetupPullRequest,
    branch: "rivet/setup-repair",
  },
];

for (const { mode, factory, branch } of SETUP_FACTORIES) {
  test(`refuses ${mode} setup from a dirty repository before creating a branch`, async (t) => {
    const { root } = await repository(t);
    await writeFile(path.join(root, "untracked.txt"), "keep me\n");
    await assert.rejects(
      factory({
        repositoryRoot: root,
        compileWorkflow: fixtureCompiler,
        validateWorkflow: async () => {},
        run: runner([]),
      }),
      /working tree must be clean/,
    );
    assert.equal(await git(root, ["branch", "--show-current"]), "main");
    assert.equal(
      await readFile(path.join(root, "untracked.txt"), "utf8"),
      "keep me\n",
    );
  });

  test(`refuses ${mode} setup when the branch already exists`, async (t) => {
    const { root } = await repository(t);
    await git(root, ["branch", branch]);
    await assert.rejects(
      factory({
        repositoryRoot: root,
        compileWorkflow: fixtureCompiler,
        validateWorkflow: async () => {},
        run: runner([]),
      }),
      /setup branch already exists/,
    );
    assert.equal(await git(root, ["branch", "--show-current"]), "main");
  });
}
