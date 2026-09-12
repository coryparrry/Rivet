import { spawn } from "node:child_process";
import {
  MODEL_SECRETS,
  sanitizedEnvironment,
  repositoryProbeEnvironment,
} from "./guided-environment.mjs";
import path from "node:path";
import { configureReviewApp, verifyReviewApp } from "./app-setup.mjs";
import {
  reviewAppAuthority,
  reviewAppRegistrationUrl,
} from "./app-authority.mjs";
import { prepareReviewInstallation } from "./install.mjs";
import { validateRivetConfig } from "./config.mjs";
import { readRivetConfiguration } from "./repository-config.mjs";
import {
  createReviewSetupPullRequest,
  repositoryFromGitHubOrigin,
  REVIEW_SETUP_BRANCH,
} from "./setup-pr.mjs";
import {
  GuidedInitCancelledError,
  runCommand,
  selectModelSecret,
  terminalPrompt,
} from "./guided-prompt.mjs";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function write(stdout, message) {
  stdout.write(`${message}\n`);
}

function required(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Rivet init: ${label} is required`);
  }
  return value.trim();
}

function invalidPreflight(message) {
  throw new Error(`Rivet init: ${message}`);
}

function validRepository(repository) {
  return (
    REPOSITORY.test(repository ?? "") &&
    repository
      .split("/")
      .every((segment) => segment !== "." && segment !== "..")
  );
}

async function configuredModelSecret({
  runner,
  repositoryRoot,
  repository,
  env,
  modelSecrets = MODEL_SECRETS,
}) {
  let secrets;
  try {
    secrets = JSON.parse(
      await runner(
        "gh",
        [
          "secret",
          "list",
          "--app",
          "actions",
          "--repo",
          repository,
          "--json",
          "name",
        ],
        { cwd: repositoryRoot, env },
      ),
    );
  } catch {
    invalidPreflight("could not read GitHub Actions secret metadata");
  }
  if (!Array.isArray(secrets)) {
    invalidPreflight("GitHub returned invalid Actions secret metadata");
  }
  return modelSecrets.find((name) =>
    secrets.some((secret) => secret?.name === name),
  );
}

async function openInBrowser(url, platform, env, spawnImpl) {
  if (platform !== "darwin")
    throw new Error("Automatic browser launch unavailable");
  await new Promise((resolve, reject) => {
    const child = spawnImpl("/usr/bin/open", [url], {
      stdio: "ignore",
      detached: true,
      env,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function setupBranchExists(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function resolveRepositoryRoot({ runner, cwd, env }) {
  try {
    const root = await runner("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      env,
    });
    return path.resolve(required(root, "Git repository root"));
  } catch {
    invalidPreflight("run this command from inside a Git repository");
  }
}

async function resolveOriginRepository({ runner, repositoryRoot, env }) {
  try {
    return repositoryFromGitHubOrigin(
      await runner("git", ["remote", "get-url", "origin"], {
        cwd: repositoryRoot,
        env,
      }),
    );
  } catch {
    invalidPreflight("origin must be an exact github.com repository URL");
  }
}

async function preflight({ runner, repositoryRoot, env, modelSecrets }) {
  const status = await runner(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repositoryRoot, env },
  );
  if (status) invalidPreflight("repository working tree must be clean");

  try {
    await runner("gh", ["auth", "status", "--hostname", "github.com"], {
      cwd: repositoryRoot,
      env,
    });
  } catch {
    invalidPreflight(
      "GitHub CLI authentication is required; run gh auth login",
    );
  }

  const originRepository = await resolveOriginRepository({
    runner,
    repositoryRoot,
    env,
  });
  let details;
  try {
    details = JSON.parse(
      await runner(
        "gh",
        [
          "repo",
          "view",
          `github.com/${originRepository}`,
          "--json",
          "nameWithOwner,defaultBranchRef,url,viewerPermission",
        ],
        { cwd: repositoryRoot, env },
      ),
    );
  } catch {
    invalidPreflight("could not resolve GitHub repository metadata");
  }
  const repository = details?.nameWithOwner;
  const defaultBranch = details?.defaultBranchRef?.name;
  if (
    !validRepository(repository) ||
    repository.toLowerCase() !== originRepository.toLowerCase() ||
    !defaultBranch
  ) {
    invalidPreflight(
      "could not resolve the GitHub repository and default branch",
    );
  }
  if (details?.url !== `https://github.com/${repository}`) {
    invalidPreflight("guided setup requires a github.com repository");
  }
  if (details?.viewerPermission !== "ADMIN") {
    invalidPreflight("guided setup requires repository admin permission");
  }
  const ownerType = await runner(
    "gh",
    [
      "api",
      "--hostname",
      "github.com",
      `repos/${repository}`,
      "--jq",
      ".owner.type",
    ],
    { cwd: repositoryRoot, env },
  );
  if (ownerType !== "User" && ownerType !== "Organization") {
    invalidPreflight("GitHub repository owner must be a User or Organization");
  }

  await runner("git", ["fetch", "origin", defaultBranch], {
    cwd: repositoryRoot,
    env,
  });
  const head = await runner("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    env,
  });
  const base = await runner(
    "git",
    ["rev-parse", `refs/remotes/origin/${defaultBranch}`],
    { cwd: repositoryRoot, env },
  );
  if (head !== base) {
    invalidPreflight(`HEAD must match origin/${defaultBranch} before setup`);
  }

  const localBranch = await runner(
    "git",
    ["branch", "--list", REVIEW_SETUP_BRANCH],
    { cwd: repositoryRoot, env },
  );
  const remoteBranch = await runner(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${REVIEW_SETUP_BRANCH}`],
    { cwd: repositoryRoot, env },
  );
  if (setupBranchExists(localBranch) || setupBranchExists(remoteBranch)) {
    invalidPreflight(`setup branch already exists: ${REVIEW_SETUP_BRANCH}`);
  }

  const existingModelSecret = await configuredModelSecret({
    runner,
    repositoryRoot,
    repository,
    env,
    modelSecrets,
  });
  return Object.freeze({
    repositoryRoot,
    repository,
    defaultBranch,
    ownerType,
    existingModelSecret,
  });
}

async function assertPreflightStillCurrent({
  runner,
  preflightResult,
  env,
  modelSecrets,
}) {
  const { repositoryRoot, repository, defaultBranch } = preflightResult;
  const status = await runner(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repositoryRoot, env },
  );
  if (status) invalidPreflight("repository working tree changed during setup");
  const originRepository = await resolveOriginRepository({
    runner,
    repositoryRoot,
    env,
  });
  const details = JSON.parse(
    await runner(
      "gh",
      [
        "repo",
        "view",
        `github.com/${originRepository}`,
        "--json",
        "nameWithOwner,defaultBranchRef,url,viewerPermission",
      ],
      { cwd: repositoryRoot, env },
    ),
  );
  if (
    details?.nameWithOwner !== repository ||
    originRepository.toLowerCase() !== repository.toLowerCase() ||
    details?.defaultBranchRef?.name !== defaultBranch ||
    details?.url !== `https://github.com/${repository}` ||
    details?.viewerPermission !== "ADMIN"
  ) {
    invalidPreflight("GitHub repository metadata changed during setup");
  }
  await runner("git", ["fetch", "origin", defaultBranch], {
    cwd: repositoryRoot,
    env,
  });
  const head = await runner("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    env,
  });
  const base = await runner(
    "git",
    ["rev-parse", `refs/remotes/origin/${defaultBranch}`],
    { cwd: repositoryRoot, env },
  );
  if (head !== base) {
    invalidPreflight(`HEAD must match origin/${defaultBranch} before setup`);
  }
  const localBranch = await runner(
    "git",
    ["branch", "--list", REVIEW_SETUP_BRANCH],
    { cwd: repositoryRoot, env },
  );
  const remoteBranch = await runner(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${REVIEW_SETUP_BRANCH}`],
    { cwd: repositoryRoot, env },
  );
  if (setupBranchExists(localBranch) || setupBranchExists(remoteBranch)) {
    invalidPreflight(`setup branch already exists: ${REVIEW_SETUP_BRANCH}`);
  }
  const existingModelSecret = await configuredModelSecret({
    runner,
    repositoryRoot,
    repository,
    env,
    modelSecrets,
  });
  if (existingModelSecret !== preflightResult.existingModelSecret) {
    invalidPreflight(
      "GitHub Actions secret metadata changed during setup; run rivet init again",
    );
  }
}

function cancelled({ stage, preflightResult, registrationUrl, authority }) {
  const guidance = {
    "app-registration": "Run rivet init again when you are ready to continue.",
    "app-installation":
      "Rivet already saved this App's repository credentials. Finish installing this same App, then rerun rivet init and reuse the same client ID and PEM. Remove the saved RIVET_APP_* settings before choosing a different App.",
    "setup-pull-request":
      "Rivet already saved and verified this App's repository credentials. Rerun rivet init and reuse the same client ID and PEM to create the setup pull request. Remove the saved RIVET_APP_* settings before choosing a different App.",
  }[stage];
  return Object.freeze({
    status: "cancelled",
    stage,
    repository: preflightResult.repository,
    ownerType: preflightResult.ownerType,
    repositoryRoot: preflightResult.repositoryRoot,
    authority,
    registrationUrl,
    guidance,
  });
}

async function promptOrCancel({
  promptAction,
  stage,
  preflightResult,
  registrationUrl,
  authority,
  stdout,
}) {
  try {
    return await promptAction();
  } catch (error) {
    if (!(error instanceof GuidedInitCancelledError)) throw error;
    const result = cancelled({
      stage,
      preflightResult,
      registrationUrl,
      authority,
    });
    write(stdout, result.guidance);
    return result;
  }
}

async function setModelSecret({
  runner,
  repository,
  repositoryRoot,
  env,
  name,
  secretInput,
  stdout,
}) {
  const args = [
    "secret",
    "set",
    name,
    "--app",
    "actions",
    "--repo",
    repository,
  ];
  let input;
  let inherited = false;
  if (typeof secretInput === "function") {
    input = await secretInput({ name, repository });
  } else if (secretInput !== undefined) {
    input = secretInput;
  } else {
    inherited = true;
    write(
      stdout,
      `Provide ${name} to the GitHub CLI now, then finish standard input to continue.`,
    );
  }
  if (typeof input === "string" && !input) {
    throw new Error("Rivet init: model secret must not be empty");
  }
  if (Buffer.isBuffer(input) && input.length === 0) {
    throw new Error("Rivet init: model secret must not be empty");
  }
  try {
    await runner("gh", args, {
      cwd: repositoryRoot,
      env,
      input,
      inheritStdin: inherited,
    });
  } catch {
    throw new Error("Rivet init: failed to store the selected model secret");
  } finally {
    if (Buffer.isBuffer(input)) input.fill(0);
  }
}

function appSummary(value) {
  return Object.freeze({
    appId: value.appId,
    appSlug: value.appSlug,
    installationUrl: value.installationUrl,
  });
}

/**
 * Guides a review-only Rivet installation without exposing credentials.
 *
 * All external dependencies are injectable for deterministic callers and tests.
 */
export async function runGuidedInit(options = {}) {
  const {
    cwd = process.cwd(),
    repositoryRoot,
    runner = runCommand,
    prompt: injectedPrompt,
    openUrl = (url, { env: browserEnvironment }) =>
      openInBrowser(
        url,
        options.platform ?? process.platform,
        browserEnvironment,
        options.spawnBrowser ?? spawn,
      ),
    configureReviewAppImpl = configureReviewApp,
    verifyReviewAppImpl = verifyReviewApp,
    createReviewSetupPullRequestImpl = createReviewSetupPullRequest,
    prepareReviewInstallationImpl = prepareReviewInstallation,
    secretInput,
    configuration: explicitConfiguration,
    readRivetConfigurationImpl = readRivetConfiguration,
  } = options;
  const stdio =
    options.stdio ??
    Object.freeze({
      stdin: options.stdin ?? process.stdin,
      stdout: options.stdout ?? process.stdout,
      stderr: options.stderr ?? process.stderr,
    });
  const credentialEnvironment =
    options.env ?? options.environment ?? process.env;
  const env = sanitizedEnvironment(credentialEnvironment, [
    explicitConfiguration?.models?.review?.endpoint?.apiKeySecret,
  ]);
  const stdout = stdio.stdout;
  const onProgress =
    options.onProgress ??
    (stdio.stderr?.isTTY
      ? (message) => stdio.stderr.write(`Rivet: ${message}...\n`)
      : undefined);
  let prompt = injectedPrompt;
  if (!prompt) {
    if (!stdio.stdin?.isTTY) {
      throw new Error(
        "Rivet init: interactive setup requires a TTY; use explicit CLI flags instead",
      );
    }
    prompt = terminalPrompt({ ...stdio, signal: options.signal });
  }
  if (
    typeof prompt.confirm !== "function" ||
    typeof prompt.input !== "function"
  ) {
    throw new Error(
      "Rivet init: prompt must provide confirm and input functions",
    );
  }

  onProgress?.("Resolving the Git repository");
  const resolvedRepositoryRoot = await resolveRepositoryRoot({
    runner,
    cwd: repositoryRoot ?? cwd,
    env: repositoryProbeEnvironment(env),
  });
  const configuration =
    explicitConfiguration ??
    (await readRivetConfigurationImpl(resolvedRepositoryRoot));
  if (configuration) validateRivetConfig(configuration);
  const endpoint = configuration?.models.review.endpoint;
  const modelSecrets = endpoint ? [endpoint.apiKeySecret] : MODEL_SECRETS;
  for (const name of modelSecrets) delete env[name];
  if (configuration?.repair?.authority === "owner") {
    throw new Error(
      "Rivet init: this repository uses repair mode; update it with rivet init --repair --setup-pr",
    );
  }
  onProgress?.("Checking repository prerequisites");
  const preflightResult = await preflight({
    runner,
    repositoryRoot: resolvedRepositoryRoot,
    env,
    modelSecrets,
  });
  onProgress?.("Compiling and checking the review workflows");
  const preparedPlan = await prepareReviewInstallationImpl({
    repositoryRoot: preflightResult.repositoryRoot,
    configuration,
    env,
    onProgress,
  });
  if (!preparedPlan.files.some(({ status }) => status !== "unchanged")) {
    throw new Error(
      "Rivet init: review-only installation is already up to date",
    );
  }
  const authority = reviewAppAuthority(configuration);
  const registrationUrl = reviewAppRegistrationUrl({
    repository: preflightResult.repository,
    ownerType: preflightResult.ownerType,
    configuration,
  });
  write(stdout, `Review authority: ${JSON.stringify(authority.permissions)}`);
  write(stdout, `Create the Rivet GitHub App: ${registrationUrl}`);
  try {
    await openUrl(registrationUrl, { env });
  } catch {
    write(
      stdout,
      "Could not open a browser; use the printed registration URL.",
    );
  }

  const registrationConfirmation = await promptOrCancel({
    promptAction: () =>
      prompt.confirm("Continue with the review-only GitHub App setup?"),
    stage: "app-registration",
    preflightResult,
    registrationUrl,
    authority,
    stdout,
  });
  if (registrationConfirmation?.status === "cancelled") {
    return registrationConfirmation;
  }
  if (!registrationConfirmation) {
    const result = cancelled({
      stage: "app-registration",
      preflightResult,
      registrationUrl,
      authority,
    });
    write(stdout, result.guidance);
    return result;
  }
  const clientIdAnswer = await promptOrCancel({
    promptAction: () => prompt.input("GitHub App client ID:"),
    stage: "app-registration",
    preflightResult,
    registrationUrl,
    authority,
    stdout,
  });
  if (clientIdAnswer?.status === "cancelled") return clientIdAnswer;
  const clientId = required(clientIdAnswer, "GitHub App client ID");
  const privateKeyPathAnswer = await promptOrCancel({
    promptAction: () => prompt.input("Path to the GitHub App private-key PEM:"),
    stage: "app-registration",
    preflightResult,
    registrationUrl,
    authority,
    stdout,
  });
  if (privateKeyPathAnswer?.status === "cancelled") {
    return privateKeyPathAnswer;
  }
  const privateKeyPath = required(
    privateKeyPathAnswer,
    "GitHub App private-key PEM path",
  );
  await assertPreflightStillCurrent({
    runner,
    preflightResult,
    env,
    modelSecrets,
  });
  onProgress?.("Configuring the review GitHub App");
  const app = await configureReviewAppImpl({
    repository: preflightResult.repository,
    clientId,
    privateKeyPath,
    configuration,
    run: (args, runOptions = {}) =>
      runner("gh", args, {
        cwd: preflightResult.repositoryRoot,
        env,
        ...runOptions,
      }),
  });
  const installationUrl = app.installationUrl;
  write(stdout, `Install the App on only this repository: ${installationUrl}`);
  try {
    await openUrl(installationUrl, { env });
  } catch {
    write(
      stdout,
      "Could not open a browser; use the printed installation URL.",
    );
  }
  const installationConfirmation = await promptOrCancel({
    promptAction: () =>
      prompt.confirm("Installed it on only the selected repository?"),
    stage: "app-installation",
    preflightResult,
    registrationUrl,
    authority,
    stdout,
  });
  if (installationConfirmation?.status === "cancelled") {
    return installationConfirmation;
  }
  if (!installationConfirmation) {
    const result = cancelled({
      stage: "app-installation",
      preflightResult,
      registrationUrl,
      authority,
    });
    write(stdout, result.guidance);
    return result;
  }
  onProgress?.("Verifying the review GitHub App installation");
  const verifiedApp = await verifyReviewAppImpl({
    repository: preflightResult.repository,
    clientId,
    privateKeyPath,
    configuration,
    run: (args, runOptions = {}) =>
      runner("gh", args, {
        cwd: preflightResult.repositoryRoot,
        env,
        ...runOptions,
      }),
  });

  const environmentModelSecret = modelSecrets.find(
    (name) =>
      typeof credentialEnvironment[name] === "string" &&
      credentialEnvironment[name],
  );
  const modelSecret =
    preflightResult.existingModelSecret ??
    environmentModelSecret ??
    endpoint?.apiKeySecret ??
    undefined;
  let selectedModelSecret = modelSecret;
  if (!selectedModelSecret) {
    selectedModelSecret = await promptOrCancel({
      promptAction: () => selectModelSecret(prompt),
      stage: "setup-pull-request",
      preflightResult,
      registrationUrl,
      authority,
      stdout,
    });
    if (selectedModelSecret?.status === "cancelled") {
      return selectedModelSecret;
    }
  }
  const modelSecretAlreadyConfigured = Boolean(
    preflightResult.existingModelSecret,
  );
  const finalAction = modelSecretAlreadyConfigured
    ? "create the verified draft setup pull request"
    : `store ${selectedModelSecret} and create the verified draft setup pull request`;
  const finalConfirmation = await promptOrCancel({
    promptAction: () => prompt.confirm(`Ready to ${finalAction}?`),
    stage: "setup-pull-request",
    preflightResult,
    registrationUrl,
    authority,
    stdout,
  });
  if (finalConfirmation?.status === "cancelled") {
    return finalConfirmation;
  }
  if (!finalConfirmation) {
    const result = cancelled({
      stage: "setup-pull-request",
      preflightResult,
      registrationUrl,
      authority,
    });
    write(stdout, result.guidance);
    return result;
  }
  await assertPreflightStillCurrent({
    runner,
    preflightResult,
    env,
    modelSecrets,
  });
  if (!modelSecretAlreadyConfigured) {
    onProgress?.("Saving the model credential");
    await setModelSecret({
      runner,
      repository: preflightResult.repository,
      repositoryRoot: preflightResult.repositoryRoot,
      env,
      name: selectedModelSecret,
      secretInput:
        secretInput ??
        (environmentModelSecret
          ? Buffer.from(credentialEnvironment[environmentModelSecret])
          : undefined),
      stdout,
    });
  }
  const setupPullRequest = await createReviewSetupPullRequestImpl({
    repositoryRoot: preflightResult.repositoryRoot,
    configuration,
    preparedPlan,
    onProgress,
    run: (command, args, runOptions = {}) =>
      runner(command, args, { env, ...runOptions }),
  });
  const result = Object.freeze({
    status: "configured",
    repository: preflightResult.repository,
    ownerType: preflightResult.ownerType,
    repositoryRoot: preflightResult.repositoryRoot,
    authority,
    registrationUrl,
    app: appSummary(app),
    verifiedApp: Object.freeze({
      appId: verifiedApp.appId,
      appSlug: verifiedApp.appSlug,
      repositorySelection: verifiedApp.repositorySelection,
      permissions: verifiedApp.permissions,
    }),
    modelSecret: Object.freeze({
      name: selectedModelSecret,
      action: modelSecretAlreadyConfigured ? "already-configured" : "stored",
    }),
    setupPullRequest: Object.freeze({
      branch: setupPullRequest.branch,
      pullRequestUrl: setupPullRequest.pullRequestUrl,
    }),
  });
  write(
    stdout,
    `Created verified draft setup pull request: ${result.setupPullRequest.pullRequestUrl}`,
  );
  write(
    stdout,
    "Next: review the draft pull request and its checks. When it is ready, mark it ready for review and merge it to activate Rivet.",
  );
  return result;
}
