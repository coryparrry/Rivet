import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  applyInstallation,
  prepareRepairInstallation,
  prepareReviewInstallation,
} from "./install.mjs";

const execFileAsync = promisify(execFile);
const PULL_REQUEST_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;
const REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/;
export const REVIEW_SETUP_BRANCH = "rivet/setup-review";
export const REPAIR_SETUP_BRANCH = "rivet/setup-repair";

function repositoryFromSegments(owner, rawName) {
  const name = rawName.endsWith(".git") ? rawName.slice(0, -4) : rawName;
  if (
    !REPOSITORY_SEGMENT.test(owner) ||
    !REPOSITORY_SEGMENT.test(name) ||
    [owner, name].some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }
  return `${owner}/${name}`;
}

export function repositoryFromGitHubOrigin(remoteUrl) {
  const value = typeof remoteUrl === "string" ? remoteUrl.trim() : "";
  const scp = /^git@github\.com:([^/]+)\/([^/]+)\/?$/.exec(value);
  if (scp) {
    const repository = repositoryFromSegments(scp[1], scp[2]);
    if (repository) return repository;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (url) {
    const secureHttps =
      url.protocol === "https:" && !url.username && !url.password;
    const secureSsh =
      url.protocol === "ssh:" && url.username === "git" && !url.password;
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      (secureHttps || secureSsh) &&
      url.hostname.toLowerCase() === "github.com" &&
      !url.port &&
      !url.search &&
      !url.hash &&
      segments.length === 2
    ) {
      const repository = repositoryFromSegments(segments[0], segments[1]);
      if (repository) return repository;
    }
  }
  throw new Error(
    "Rivet installer: origin must be an exact github.com repository URL",
  );
}

async function originRepository({ run, cwd }) {
  return repositoryFromGitHubOrigin(
    await run("git", ["remote", "get-url", "origin"], { cwd }),
  );
}

async function runCommand(command, args, { cwd }) {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

function assertExactPaths(actual, expected) {
  const actualPaths = actual.split("\0").filter(Boolean).sort();
  const expectedPaths = [...expected].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      "Rivet installer: staged files do not match the install plan",
    );
  }
}

function firstRefOid(value) {
  return typeof value === "string" ? (value.trim().split(/\s+/)[0] ?? "") : "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function cleanupSetupBranch({
  run,
  cwd,
  branch,
  base,
  commit,
  restoreBranch,
  restoreHead,
  paths,
  createPaths,
  filesStaged,
  pullRequestUrl,
  repository,
  defaultBranch,
  mode,
}) {
  const failures = [];
  const notes = [];
  let restored = false;

  let cleanupPullRequestUrl = pullRequestUrl;
  if (!cleanupPullRequestUrl && commit) {
    try {
      const candidates = JSON.parse(
        await run(
          "gh",
          [
            "pr",
            "list",
            "--repo",
            `github.com/${repository}`,
            "--base",
            defaultBranch,
            "--head",
            branch,
            "--state",
            "open",
            "--json",
            "baseRefName,headRefName,headRefOid,isDraft,state,title,url",
          ],
          { cwd },
        ),
      );
      const exact = Array.isArray(candidates)
        ? candidates.filter(
            (candidate) =>
              candidate.baseRefName === defaultBranch &&
              candidate.headRefName === branch &&
              candidate.headRefOid === commit &&
              candidate.isDraft === true &&
              candidate.state === "OPEN" &&
              candidate.title === `chore: set up Rivet ${mode}` &&
              PULL_REQUEST_URL.test(candidate.url),
          )
        : [];
      if (exact.length === 1) cleanupPullRequestUrl = exact[0].url;
      else if (exact.length > 1) {
        failures.push("could not identify one exact setup pull request to close");
      }
    } catch (error) {
      failures.push(
        `could not discover a setup pull request to close: ${errorMessage(error)}`,
      );
    }
  }

  if (cleanupPullRequestUrl) {
    try {
      await run(
        "gh",
        [
          "pr",
          "close",
          cleanupPullRequestUrl,
          "--repo",
          `github.com/${repository}`,
        ],
        { cwd },
      );
    } catch (error) {
      failures.push(
        `could not close ${cleanupPullRequestUrl}: ${errorMessage(error)}`,
      );
    }
  }

  try {
    if (filesStaged) {
      await run(
        "git",
        ["restore", `--source=${base}`, "--staged", "--worktree", "--", ...paths],
        { cwd },
      );
    } else {
      const trackedPaths = paths.filter(
        (candidate) => !createPaths.has(candidate),
      );
      if (trackedPaths.length > 0) {
        await run(
          "git",
          ["restore", `--source=${base}`, "--worktree", "--", ...trackedPaths],
          { cwd },
        );
      }
      if (createPaths.size > 0) {
        await run("git", ["clean", "-f", "--", ...createPaths], { cwd });
      }
    }
  } catch (error) {
    failures.push(`could not restore setup files: ${errorMessage(error)}`);
  }

  try {
    await run(
      "git",
      restoreBranch
        ? ["switch", restoreBranch]
        : ["switch", "--detach", restoreHead],
      { cwd },
    );
    restored = true;
  } catch (error) {
    failures.push(
      `could not restore ${restoreBranch ?? `detached HEAD ${restoreHead}`}: ${errorMessage(error)}`,
    );
  }

  if (commit) {
    try {
      const remoteOid = firstRefOid(
        await run(
          "git",
          ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
          { cwd },
        ),
      );
      if (remoteOid === commit) {
        await run(
          "git",
          [
            "push",
            `--force-with-lease=refs/heads/${branch}:${commit}`,
            "origin",
            `:refs/heads/${branch}`,
          ],
          { cwd },
        );
      } else if (remoteOid) {
        notes.push(
          `remote setup branch ${branch} was not deleted because it now points to ${remoteOid} (expected ${commit})`,
        );
      }
    } catch (error) {
      failures.push(
        `could not clean up remote ${branch}: ${errorMessage(error)}`,
      );
    }
  }

  if (restored) {
    try {
      const localOid = firstRefOid(
        await run(
          "git",
          ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`],
          { cwd },
        ),
      );
      const expectedLocalOid = commit ?? base;
      if (localOid === expectedLocalOid) {
        await run("git", ["update-ref", "-d", `refs/heads/${branch}`, localOid], {
          cwd,
        });
      } else if (localOid) {
        notes.push(
          `local setup branch ${branch} was not deleted because it now points to ${localOid} (expected ${expectedLocalOid})`,
        );
      }
    } catch (error) {
      failures.push(
        `could not clean up local ${branch}: ${errorMessage(error)}`,
      );
    }
  } else {
    failures.push(
      `local ${branch} cleanup was skipped because branch restoration failed`,
    );
  }

  return { failures, notes };
}

function setupFailureWithCleanup(error, { failures, notes }) {
  const details = [...failures, ...notes];
  if (details.length === 0) return error;
  const combined = new Error(
    `${errorMessage(error)}; setup cleanup: ${details.join("; ")}`,
    { cause: error },
  );
  combined.cleanupFailures = failures;
  combined.cleanupNotes = notes;
  return combined;
}

function pullRequestBody(plan) {
  const files = plan.files.map(({ path }) => `- \`${path}\``).join("\n");
  const authority = plan.productAuthority.map((line) => `- ${line}`).join("\n");
  return `## Summary

This draft installs the Rivet workflows selected in the configuration. Issue implementation and merge authority remain disabled; maintenance is always report-only.

## Product authority

${authority}

## Managed files

${files}

Rivet created this pull request but will never merge it automatically.`;
}

async function createSetupPullRequest({
  branch,
  mode,
  run = runCommand,
  prepare,
  preparedPlan,
  onProgress,
  ...installOptions
} = {}) {
  const plan =
    preparedPlan ?? (await prepare({ ...installOptions, onProgress }));
  if (plan.mode !== mode) {
    throw new Error(`Rivet installer: expected a ${mode} installation plan`);
  }
  const cwd = plan.repositoryRoot;
  const paths = plan.files
    .filter(({ status }) => status !== "unchanged")
    .map(({ path }) => path);
  if (paths.length === 0) {
    throw new Error(`Rivet installer: ${plan.mode} installation is up to date`);
  }
  onProgress?.("Creating Rivet setup pull request");

  await run("git", ["check-ref-format", "--branch", branch], { cwd });
  const status = await run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd },
  );
  if (status) {
    throw new Error("Rivet installer: repository working tree must be clean");
  }

  const expectedRepository = await originRepository({ run, cwd });

  const repositoryDetails = JSON.parse(
    await run(
      "gh",
      [
        "repo",
        "view",
        `github.com/${expectedRepository}`,
        "--json",
        "nameWithOwner,defaultBranchRef",
      ],
      { cwd },
    ),
  );
  const repository = repositoryDetails.nameWithOwner;
  const defaultBranch = repositoryDetails.defaultBranchRef?.name;
  if (
    !repository ||
    repository.toLowerCase() !== expectedRepository.toLowerCase() ||
    !defaultBranch
  ) {
    throw new Error("Rivet installer: could not resolve the GitHub repository");
  }

  await run("git", ["fetch", "origin", defaultBranch], { cwd });
  const head = await run("git", ["rev-parse", "HEAD"], { cwd });
  const base = await run(
    "git",
    ["rev-parse", `refs/remotes/origin/${defaultBranch}`],
    { cwd },
  );
  if (head !== base) {
    throw new Error(
      `Rivet installer: HEAD must match origin/${defaultBranch} before setup`,
    );
  }

  const localBranch = await run("git", ["branch", "--list", branch], { cwd });
  const remoteBranch = await run(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { cwd },
  );
  if (localBranch || remoteBranch) {
    throw new Error(`Rivet installer: setup branch already exists: ${branch}`);
  }

  const originalBranchOutput = await run("git", ["branch", "--show-current"], {
    cwd,
  });
  const originalBranch = String(originalBranchOutput ?? "").trim() || null;
  const originalHead = head;
  const createPaths = new Set(
    plan.files
      .filter(({ status }) => status === "create")
      .map(({ path: filePath }) => filePath),
  );
  let commit = null;
  let filesStaged = false;
  let pullRequestUrl = null;

  try {
    await run("git", ["switch", "-c", branch, base], { cwd });
    await applyInstallation(plan, { onProgress });
    filesStaged = true;
    await run("git", ["add", "--", ...paths], { cwd });
    assertExactPaths(
      await run("git", ["diff", "--cached", "--name-only", "-z"], { cwd }),
      paths,
    );
    await run("git", ["diff", "--cached", "--check"], { cwd });
    await run(
      "git",
      [
        "commit",
        "--only",
        "-m",
        `chore: set up Rivet ${plan.mode}`,
        "--",
        ...paths,
      ],
      { cwd },
    );

    commit = await run("git", ["rev-parse", "HEAD"], { cwd });
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      throw new Error("Rivet installer: setup commit is not a full Git SHA");
    }
    const parent = await run("git", ["rev-parse", `${commit}^`], { cwd });
    if (parent !== base) {
      throw new Error("Rivet installer: setup commit has an unexpected parent");
    }

    await run(
      "git",
      [
        "push",
        `--force-with-lease=refs/heads/${branch}:`,
        "origin",
        `${commit}:refs/heads/${branch}`,
      ],
      { cwd },
    );
    const pushedBranch = await run(
      "git",
      ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
      { cwd },
    );
    if (firstRefOid(pushedBranch) !== commit) {
      throw new Error(
        "Rivet installer: pushed setup branch does not match the setup commit",
      );
    }
    const createdPullRequestUrl = await run(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        `github.com/${repository}`,
        "--base",
        defaultBranch,
        "--head",
        branch,
        "--draft",
        "--title",
        `chore: set up Rivet ${plan.mode}`,
        "--body",
        pullRequestBody(plan),
      ],
      { cwd },
    );
    if (!PULL_REQUEST_URL.test(createdPullRequestUrl)) {
      throw new Error(
        "Rivet installer: GitHub returned an invalid pull-request URL",
      );
    }
    pullRequestUrl = createdPullRequestUrl;
    const pullRequest = JSON.parse(
      await run(
        "gh",
        [
          "pr",
          "view",
          pullRequestUrl,
          "--json",
          "baseRefName,headRefName,headRefOid,isDraft,state,url",
        ],
        { cwd },
      ),
    );
    if (
      pullRequest.url !== pullRequestUrl ||
      pullRequest.baseRefName !== defaultBranch ||
      pullRequest.headRefName !== branch ||
      pullRequest.headRefOid !== commit ||
      pullRequest.isDraft !== true ||
      pullRequest.state !== "OPEN"
    ) {
      throw new Error(
        "Rivet installer: setup pull request does not match the verified plan",
      );
    }

    return Object.freeze({
      repository,
      defaultBranch,
      branch,
      commit,
      pullRequestUrl,
    });
  } catch (error) {
    const cleanup = await cleanupSetupBranch({
      run,
      cwd,
      branch,
      base,
      commit,
      restoreBranch: originalBranch,
      restoreHead: originalHead,
      paths,
      createPaths,
      filesStaged,
      pullRequestUrl,
      repository,
      defaultBranch,
      mode,
    });
    throw setupFailureWithCleanup(error, cleanup);
  }
}

export function createReviewSetupPullRequest(options = {}) {
  return createSetupPullRequest({
    branch: REVIEW_SETUP_BRANCH,
    ...options,
    mode: "review",
    prepare: prepareReviewInstallation,
  });
}

export function createRepairSetupPullRequest(options = {}) {
  return createSetupPullRequest({
    branch: REPAIR_SETUP_BRANCH,
    ...options,
    mode: "repair",
    prepare: prepareRepairInstallation,
  });
}
