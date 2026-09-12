import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { runGuidedInit } from "../src/guided-init.mjs";

const ROOT = "/work/example";
const REPOSITORY = "acme/widget";
const PEM_PATH = "/keys/rivet.pem";
const CLIENT_ID = "Iv123456789012345678";

function output() {
  let value = "";
  return {
    stream: { write: (chunk) => (value += chunk) },
    read: () => value,
  };
}

async function settleWithin(promise, milliseconds = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("guided setup did not settle")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function runner({ ownerType = "User", existingSecrets = [] } = {}) {
  const run = async (command, args, options = {}) => {
    if (
      command === "git" &&
      args[0] === "rev-parse" &&
      args[1] === "--show-toplevel"
    ) {
      return ROOT;
    }
    if (command === "git" && args[0] === "status") return "";
    if (command === "git" && args[0] === "remote") {
      return `https://github.com/${REPOSITORY}.git`;
    }
    if (command === "git" && args[0] === "rev-parse") return "a".repeat(40);
    if (command === "git" && args[0] === "branch") return "";
    if (command === "git" && args[0] === "ls-remote") return "";
    if (command === "git" && args[0] === "fetch") return "";
    if (command === "gh" && args[0] === "auth") return "";
    if (command === "gh" && args[0] === "repo") {
      return JSON.stringify({
        nameWithOwner: REPOSITORY,
        defaultBranchRef: { name: "main" },
        url: `https://github.com/${REPOSITORY}`,
        viewerPermission: "ADMIN",
      });
    }
    if (command === "gh" && args[0] === "api") return ownerType;
    if (command === "gh" && args[0] === "secret" && args[1] === "list") {
      return JSON.stringify(existingSecrets.map((name) => ({ name })));
    }
    throw new Error(
      `unexpected command: ${command} ${args.join(" ")} ${JSON.stringify(options)}`,
    );
  };
  return run;
}

function dependencies() {
  const configured = [];
  const verified = [];
  const setup = [];
  return {
    configured,
    verified,
    setup,
    prepareReviewInstallationImpl: async () => ({
      files: [
        { path: ".github/workflows/rivet-review.lock.yml", status: "create" },
      ],
    }),
    configureReviewAppImpl: async (options) => {
      configured.push(options);
      return {
        appId: 42,
        appSlug: "rivet-review",
        installationUrl:
          "https://github.com/apps/rivet-review/installations/new",
      };
    },
    verifyReviewAppImpl: async (options) => {
      verified.push(options);
      return {
        appId: 42,
        appSlug: "rivet-review",
        repositorySelection: "selected",
        permissions: {
          contents: "read",
          metadata: "read",
          pullRequests: "write",
        },
      };
    },
    createReviewSetupPullRequestImpl: async (options) => {
      setup.push(options);
      return {
        branch: "rivet/setup-review",
        pullRequestUrl: "https://github.com/acme/widget/pull/7",
      };
    },
  };
}

const noConfiguration = { readRivetConfigurationImpl: async () => undefined };

test("turns a real stdin EOF after App configuration into staged rerun guidance", async () => {
  const stdin = new Readable({ read() {} });
  stdin.isTTY = true;
  const answers = ["yes\n", `${CLIENT_ID}\n`, `${PEM_PATH}\n`];
  const stdout = output();
  const originalWrite = stdout.stream.write;
  stdout.stream.write = (chunk) => {
    originalWrite(chunk);
    if (/(?:\[y\/N\] |client ID: |private-key PEM: )$/.test(chunk)) {
      const answer = answers.shift();
      queueMicrotask(() =>
        answer === undefined ? stdin.push(null) : stdin.push(answer),
      );
    }
  };
  const deps = dependencies();
  const result = await settleWithin(
    runGuidedInit({
      stdin,
      stdout: stdout.stream,
      runner: runner(),
      openUrl: async () => {},
      ...noConfiguration,
      ...deps,
    }),
  );

  assert.deepEqual(
    { status: result.status, stage: result.stage },
    { status: "cancelled", stage: "app-installation" },
  );
  assert.match(
    result.guidance,
    /already saved this App's repository credentials/,
  );
  assert.match(
    stdout.read(),
    /already saved this App's repository credentials/,
  );
  assert.equal(deps.configured.length, 1);
  assert.equal(deps.verified.length, 0);
  assert.equal(deps.setup.length, 0);
  assert.equal(stdin.listenerCount("end"), 0);
  assert.equal(stdin.listenerCount("close"), 0);
});

test("turns a readline abort into app-registration rerun guidance without lingering listeners", async () => {
  const stdin = new Readable({ read() {} });
  stdin.isTTY = true;
  const abortController = new AbortController();
  const stdout = output();
  const originalWrite = stdout.stream.write;
  stdout.stream.write = (chunk) => {
    originalWrite(chunk);
    if (chunk.endsWith("[y/N] ")) {
      queueMicrotask(() => abortController.abort());
    }
  };
  const deps = dependencies();
  const result = await settleWithin(
    runGuidedInit({
      stdin,
      stdout: stdout.stream,
      signal: abortController.signal,
      runner: runner(),
      openUrl: async () => {},
      ...noConfiguration,
      ...deps,
    }),
  );

  assert.deepEqual(
    { status: result.status, stage: result.stage },
    { status: "cancelled", stage: "app-registration" },
  );
  assert.match(result.guidance, /Run rivet init again/);
  assert.match(stdout.read(), /Run rivet init again/);
  assert.equal(deps.configured.length, 0);
  assert.equal(stdin.listenerCount("end"), 0);
  assert.equal(stdin.listenerCount("close"), 0);
  stdin.destroy();
});
