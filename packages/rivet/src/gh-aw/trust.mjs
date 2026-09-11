import {
  hasExactlyKeys,
  issueTriageAuthorityDigest,
  maintenanceAuthorityDigests,
  repairAuthorityDigest,
  reviewAuthorityDigest,
  reviewInlineLimit,
  sameValues,
} from "./authority-inventory.mjs";

export {
  issueTriageAuthorityDigest,
  maintenanceAuthorityDigests,
  repairAuthorityDigest,
  reviewAuthorityDigest,
} from "./authority-inventory.mjs";

const MAINTENANCE_SHARED_SECRETS = [
  "COPILOT_GITHUB_TOKEN",
  "GH_AW_GITHUB_MCP_SERVER_TOKEN",
  "GH_AW_GITHUB_TOKEN",
  "GITHUB_TOKEN",
];
const MAINTENANCE_PROVIDER_SECRETS = Object.freeze({
  codex: ["CODEX_API_KEY", "OPENAI_API_KEY"],
  claude: ["ANTHROPIC_API_KEY"],
  copilot: [],
  gemini: ["GEMINI_API_KEY"],
});

// These hashes bind the complete compiled shape produced by the pinned gh-aw
// release. They are intentionally not derived from the candidate authority.
export const RIVET_MAINTENANCE_ACTIONS_SHA256 =
  "ad7df34683b3ab83e39cb0fce683600ce04877c42d4d80778def9d58d25c1ad5";
export const RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256 =
  "dcb9f93ac56879b15276b6cb780245b284ea25590ee5e299f7174063a80c3291";
export const RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256 =
  "74b5d1f0163c93c16b6a7a44aee902ba4f529433bdc0a08748cfad74184771dc";
export const RIVET_REVIEW_AUTHORITY_SHA256_BY_POLICY = Object.freeze({
  "automatic:inline:comment:claude": "7cc743b25c7c0cdf43ade70e2149022936e2b4ebb1b77661250dcc1a3443967c",
  "automatic:inline:comment:codex": "b1bc2f7bda95db2bf6097785f2a1c92f3c6652d04493934b56ad9f9e2a8d8a30",
  "automatic:inline:comment:copilot": "1e110874f79c4f371920a52d40f8dae109d0f40f1acf6e458d06bb4f0a7bcce8",
  "automatic:inline:comment:gemini": "97706bc2e8c88b6dee1e2f2eab2c28459d5edcc97d7493baf53a0cfaffc6ce35",
  "automatic:inline:request-changes:claude": "6a125fe56ff8035321f0507e405462be4673879c50b2222d7fcaac1b3318c2c0",
  "automatic:inline:request-changes:codex": "4422e4a688ede8c0b2691d03ac2ecf744c9c0215089c44eb927f5a2f5ce2b6b6",
  "automatic:inline:request-changes:copilot": "5b447c3bf391b83663831898bc4e1551a8c62b4aa21a2baec54295192ea98efa",
  "automatic:inline:request-changes:gemini": "79b1229b684f6b626c1e66de3eb4d7e197ab15da39c661e36079d4cdb4d43578",
  "automatic:summary:comment:claude": "aebb4a08fa91ab035c32d1e80e0b893ebc678c04982ea3640ed8be2dde9b401e",
  "automatic:summary:comment:codex": "16b9a892730f9639ff5ec3634c7f7922264b232c9a26f7e1ac4550048d2fae2d",
  "automatic:summary:comment:copilot": "d517db18999f03c1670c9e46792422438fb97245824df989f67468fe30812e8b",
  "automatic:summary:comment:gemini": "41972c22110d520b2ecce5bfc7a317b23f9bac4107e0ca29286d952a51e12e27",
  "automatic:summary:request-changes:claude": "b92e6f9c513fd0c0ca4b51bf51062698a43abb39d2341c7bd32c02ffaff433dd",
  "automatic:summary:request-changes:codex": "99bf29e6d40293eca9d5a6fd2d4e024deb27d966db1babce823fe021fed3a3ed",
  "automatic:summary:request-changes:copilot": "6ff2a3e9540978c718bf5af3dbad437d58f9478d60636d01281435be272e52e3",
  "automatic:summary:request-changes:gemini": "e6079c7bf6b0370105f4d3aa5f6e336e40b9995f721676d1204bc98f245c07da",
  "disabled:inline:comment:claude": "f22e77599124bae180b6b5f9a99ad1a131c077c9955835ddfc4d4feeb097aeb3",
  "disabled:inline:comment:codex": "1dc30f02c0ea69e04eb4969e8f61ab658b94d794ff35c2ae36dd566289e4b963",
  "disabled:inline:comment:copilot": "9e1a8ddcc587deeaddcf9c376b78a462cb23b42e67317982fa20dd9a303cc7fa",
  "disabled:inline:comment:gemini": "fa82a186f35f9cbc3e1d6afe475470f8affec3e2e949e121237fd032098d68c9",
  "disabled:inline:request-changes:claude": "0ca2cc56137875929186c2deee01fa1e247555399814c7e99184eb22db1e189a",
  "disabled:inline:request-changes:codex": "923d32f878da7052d5f4e52c1a9791a54d98fe1c65bdb36eebb2ff6895d257ec",
  "disabled:inline:request-changes:copilot": "a34cb2c8dc7fc4165a4b99f3a4ac7c548226af2422f3ff39808bd5987cd96ed4",
  "disabled:inline:request-changes:gemini": "1a6fbd37936f6333593182b02da36ef51396012eb5544015c0c1d58ba663255f",
  "disabled:summary:comment:claude": "dc59b76a32dffa4aaae0cba6fa9bf923b26c56c0a82412540ebda0733b8a36f6",
  "disabled:summary:comment:codex": "b2ed457ad38f56728c75fb9f5f5311a36434e1b20310068465bbf26209fd4006",
  "disabled:summary:comment:copilot": "892a52a7a25ea11f70429772e1e3523eeddbbcbb3d22a1017e4e4d6717bbdf7f",
  "disabled:summary:comment:gemini": "abfff3bab0030b9c1cee1eb4285119f75098027a42ed682b980014e01626bcfe",
  "disabled:summary:request-changes:claude": "c28b6222bbf4015f79daac593ab2200c93a2fa90432da0895b24e1808613e926",
  "disabled:summary:request-changes:codex": "676a53207523740b0094031ca5374c87bffae966968e3c0614cc439f6387edbf",
  "disabled:summary:request-changes:copilot": "77412932374371d032647656755525bfb610ef330402199ca78d71d7fc72e5f3",
  "disabled:summary:request-changes:gemini": "4271c5a22d2e6863f95c69a3c53354c2be41d56def3af2a6d3b00c313c28b3cd",
});
export const RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE = Object.freeze({
  claude: "f1ac491b665080316eb9ae1c0b9762b58d39e416c09677dd28a6e54d5ccf5ea4",
  codex: "9fbb8d8e217a3dae414e85208674a68421494111d2d21425ee7ad8f89a76c011",
  copilot: "ee0dc306c0fbf944d077f1637edee60d1fe30d989db0a75da961d23aa4015ffb",
  gemini: "4a55ecdcb1d007d048e7816d1209c91bbc20fe4e1358fe6b77484454fa813238",
});
export const RIVET_REPAIR_AUTHORITY_SHA256_BY_ENGINE = Object.freeze({
  claude: "87870bfbc174c9dadba231ec7d8f28424f9eba2211ee2c08d4794ac968f66e4e",
  codex: "31244559a157bedda15629c421d63da758b54406a3e4d249383334dd8509d5d8",
  copilot: "57949b260868ff68be64885aaabb3b4f79e0720bc124b70f92427af30a5a8eaa",
  gemini: "6fae4c1bcb0dda44482295d7113e0e6d47198fc02d62d6a29f3b7bed7ef22613",
});

function reviewWriteAuthorityIsNarrow(authority) {
  const writeJobs = authority.writeCapableJobs ?? [];
  if (
    writeJobs.length !== 2 ||
    !sameValues(writeJobs.map(({ job }) => job).sort(), [
      "conclusion",
      "safe_outputs",
    ])
  ) {
    return false;
  }
  for (const { permissions } of writeJobs) {
    if (
      permissions["pull-requests"] !== "write" ||
      (permissions.issues !== undefined && permissions.issues !== "write") ||
      Object.keys(permissions).some(
        (permission) =>
          permission !== "issues" && permission !== "pull-requests",
      )
    ) {
      return false;
    }
  }
  for (const job of ["agent", "conclusion", "safe_outputs"]) {
    const jobAuthority = authority.jobAuthority?.[job];
    if (
      !jobAuthority ||
      jobAuthority.container !== null ||
      jobAuthority.environment !== null ||
      jobAuthority.services !== null
    ) {
      return false;
    }
  }
  return (
    authority.jobAuthority.agent.runsOn === "ubuntu-latest" &&
    JSON.stringify(authority.jobAuthority.agent.permissions) ===
      JSON.stringify({ contents: "read", "pull-requests": "read" }) &&
    authority.jobAuthority.conclusion.runsOn === "ubuntu-slim" &&
    authority.jobAuthority.safe_outputs.runsOn === "ubuntu-slim"
  );
}

function reviewSafeOutputsAreBounded(
  authority,
  expectedIssueTriage,
  expectedInlineFindings,
  expectedRequestChanges,
) {
  const config = authority.safeOutputConfig;
  if (!config || typeof config !== "object" || Array.isArray(config))
    return false;
  const allowed = new Set([
    "create_issue",
    "create_pull_request_review_comment",
    "missing_data",
    "missing_tool",
    "noop",
    "report_incomplete",
    "submit_pull_request_review",
  ]);
  if (Object.keys(config).some((name) => !allowed.has(name))) return false;
  const inline = config.create_pull_request_review_comment;
  const issue = config.create_issue;
  const review = config.submit_pull_request_review;
  const expectedIssuePermission = issue ? "write" : undefined;
  const publicationJobs = new Set(["conclusion", "safe_outputs"]);
  const appTokens = (authority.actions ?? []).filter(
    ({ action, job }) =>
      publicationJobs.has(job) && action === "actions/create-github-app-token",
  );
  return (
    Boolean(issue) === (expectedIssueTriage === "automatic") &&
    Boolean(inline) === expectedInlineFindings &&
    sameValues(authority.safeOutputJobs, ["safe_outputs"]) &&
    appTokens.length === 2 &&
    appTokens.every(
      ({ with: actionWith }) =>
        actionWith?.["permission-issues"] === expectedIssuePermission,
    ) &&
    [...publicationJobs].every(
      (job) =>
        authority.jobAuthority?.[job]?.permissions?.issues ===
        expectedIssuePermission,
    ) &&
    (!inline ||
      (hasExactlyKeys(inline, ["max", "side"]) &&
        Number.isInteger(inline.max) &&
        inline.max >= 1 &&
        inline.max <= 20 &&
        inline.side === "RIGHT")) &&
    (!issue ||
      (hasExactlyKeys(issue, ["deduplicate_by_title", "max", "title_prefix"]) &&
        issue.deduplicate_by_title === true &&
        issue.max === 1 &&
        issue.title_prefix === "[rivet] ")) &&
    hasExactlyKeys(review, ["allowed_events", "max"]) &&
    review.max === 1 &&
    sameValues(
      review.allowed_events,
      expectedRequestChanges ? ["COMMENT", "REQUEST_CHANGES"] : ["COMMENT"],
    ) &&
    config.noop?.max === 1 &&
    config.noop?.["report-as-issue"] === "false" &&
    authority.safeOutputSettings?.failureReportAsIssue === "false" &&
    authority.safeOutputSettings?.missingDataReportAsFailure === "true" &&
    authority.safeOutputSettings?.missingToolReportAsFailure === "true" &&
    authority.safeOutputSettings?.noopReportAsIssue === "false" &&
    authority.safeOutputSettings?.reportIncompleteCreateIssue === "false"
  );
}

function issueTriageSafeOutputsAreBounded(authority) {
  const config = authority.safeOutputConfig;
  const settings = authority.safeOutputSettings;
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    !settings ||
    typeof settings !== "object" ||
    Array.isArray(settings)
  ) {
    return false;
  }
  return (
    hasExactlyKeys(config, [
      "missing_data",
      "missing_tool",
      "noop",
      "report_incomplete",
    ]) &&
    hasExactlyKeys(config.missing_data, []) &&
    hasExactlyKeys(config.missing_tool, []) &&
    hasExactlyKeys(config.report_incomplete, []) &&
    hasExactlyKeys(config.noop, ["max", "report-as-issue"]) &&
    config.noop.max === 1 &&
    config.noop["report-as-issue"] === "false" &&
    hasExactlyKeys(settings, [
      "failureReportAsIssue",
      "missingDataReportAsFailure",
      "missingToolReportAsFailure",
      "noopReportAsIssue",
      "reportIncompleteCreateIssue",
    ]) &&
    settings.failureReportAsIssue === "false" &&
    settings.missingDataReportAsFailure === "true" &&
    settings.missingToolReportAsFailure === "true" &&
    settings.noopReportAsIssue === "false" &&
    settings.reportIncompleteCreateIssue === "false"
  );
}

function maintenanceSecrets(expectedEngine) {
  const provider = MAINTENANCE_PROVIDER_SECRETS[expectedEngine];
  if (!provider) return null;
  return [...new Set([...MAINTENANCE_SHARED_SECRETS, ...provider])].sort();
}

function issueTriageSecrets(expectedEngine) {
  const provider = MAINTENANCE_PROVIDER_SECRETS[expectedEngine];
  if (!provider) return null;
  return [
    ...new Set([
      ...MAINTENANCE_SHARED_SECRETS,
      ...provider,
      "RIVET_APP_PRIVATE_KEY",
    ]),
  ].sort();
}

export function assessMaintenanceTrust({
  authority,
  expectedEngine,
  expectedImports = [],
  expectedModel,
  expectedTriggers = [],
  expectedActionsSha256 = RIVET_MAINTENANCE_ACTIONS_SHA256,
  expectedJobConditionsSha256 = RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256,
  expectedJobAuthoritySha256 = RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256,
  expectedSecrets,
  expectedLocalActions = [],
}) {
  const violations = [];
  if (!sameValues(authority.triggers, expectedTriggers)) {
    violations.push("maintenance trigger differs from the approved inventory");
  }
  if (authority.metadata.strict !== true) {
    violations.push("compiler strict mode is required");
  }
  if (
    authority.metadata.agent_id !== expectedEngine ||
    authority.metadata.agent_model !== expectedModel
  ) {
    violations.push("maintenance model differs from the configured model");
  }
  if (!authority.inlinedImports) {
    violations.push("workflow and native imports must be inlined");
  }
  if (!sameValues(authority.resolvedImports, expectedImports)) {
    violations.push(
      "resolved native imports differ from the approved inventory",
    );
  }
  if (authority.runtimeImports.length > 0) {
    violations.push("runtime prompt imports are not allowed");
  }
  if (authority.unpinnedActions.length > 0) {
    violations.push("all actions must use immutable commit pins");
  }
  if (authority.unpinnedContainers.length > 0) {
    violations.push("all containers must use immutable digest pins");
  }
  if (!sameValues(authority.localActions, expectedLocalActions)) {
    violations.push("local actions differ from the approved inventory");
  }
  if (!sameValues(authority.safeOutputJobs, [])) {
    violations.push("maintenance cannot use a generic safe-output publisher");
  }
  if (JSON.stringify(authority.permissions) !== JSON.stringify({})) {
    violations.push("maintenance root permissions must remain empty");
  }
  const approvedSecrets = expectedSecrets ?? maintenanceSecrets(expectedEngine);
  if (
    !approvedSecrets ||
    !sameValues(authority.secrets, approvedSecrets) ||
    !sameValues(authority.manifestSecrets, approvedSecrets)
  ) {
    violations.push("maintenance secrets differ from the approved inventory");
  }
  if (
    authority.safeOutputConfig !== null ||
    authority.safeOutputSettings?.reportIncompleteCreateIssue !== "false" ||
    authority.safeOutputSettings?.failureReportAsIssue !== "false" ||
    authority.safeOutputSettings?.noopReportAsIssue !== "false" ||
    authority.safeOutputSettings?.missingDataReportAsFailure !== "true" ||
    authority.safeOutputSettings?.missingToolReportAsFailure !== "true"
  ) {
    violations.push(
      "maintenance safe outputs must disable missing data, missing tools, and issue reporting",
    );
  }
  if (authority.additionalRepositories.length > 0) {
    violations.push("additional repository checkouts are not allowed");
  }
  if (
    authority.checkouts.length === 0 ||
    authority.checkouts.some(
      ({ repository, ref, path, persistCredentials }) =>
        repository !== null ||
        (ref !== null &&
          ref !== "refs/heads/${{ github.event.repository.default_branch }}" &&
          ref !== "${{ github.sha }}") ||
        path !== null ||
        persistCredentials !== false,
    )
  ) {
    violations.push(
      "checkouts must use the default branch without persisted credentials",
    );
  }
  if (!issueWriteJobsOnly(authority.writeCapableJobs)) {
    violations.push(
      "only conclusion may use workflow write authority for cancellation",
    );
  }
  const maintenanceDigests = maintenanceAuthorityDigests(authority);
  if (
    !expectedActionsSha256 ||
    maintenanceDigests.actions !== expectedActionsSha256
  ) {
    violations.push("maintenance actions differ from the approved inventory");
  }
  if (
    !expectedJobConditionsSha256 ||
    maintenanceDigests.jobConditions !== expectedJobConditionsSha256
  ) {
    violations.push(
      "maintenance job conditions differ from the approved inventory",
    );
  }
  if (
    !expectedJobAuthoritySha256 ||
    maintenanceDigests.jobAuthority !== expectedJobAuthoritySha256
  ) {
    violations.push(
      "maintenance runner, container, permissions, environment, or services differ from the approved inventory",
    );
  }
  return Object.freeze({
    trusted: violations.length === 0,
    baseContext: "maintenance default branch",
    violations: Object.freeze(violations),
  });
}

function issueWriteJobsOnly(writeCapableJobs) {
  return (
    writeCapableJobs.length === 1 &&
    writeCapableJobs[0].job === "conclusion" &&
    JSON.stringify(writeCapableJobs[0].permissions) ===
      JSON.stringify({ actions: "write" })
  );
}

function issuePublisherOnly(actions, expectedScript) {
  const publisher = actions.filter(
    ({ job }) => job === "publish_triage_comment",
  );
  const token = publisher.find(
    ({ action }) => action === "actions/create-github-app-token",
  );
  const script = publisher.find(
    ({ action }) => action === "actions/github-script",
  );
  const tokenWith = token?.with ?? {};
  const scriptWith = script?.with ?? {};
  return (
    publisher.length === 3 &&
    sameValues(
      publisher.map(({ uses }) => uses),
      [
        "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
        "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
        "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
      ],
    ) &&
    Object.keys(tokenWith).length === 5 &&
    tokenWith["app-id"] === "${{ vars.RIVET_APP_CLIENT_ID }}" &&
    tokenWith["private-key"] === "${{ secrets.RIVET_APP_PRIVATE_KEY }}" &&
    tokenWith.owner === "${{ github.repository_owner }}" &&
    tokenWith.repositories === "${{ github.event.repository.name }}" &&
    tokenWith["permission-issues"] === "write" &&
    Object.keys(scriptWith).length === 2 &&
    scriptWith["github-token"] === "${{ steps.issue-token.outputs.token }}" &&
    scriptWith.script === `${expectedScript}\n`
  );
}

export function assessIssueTriageTrust({
  authority,
  expectedEngine,
  expectedImports = [],
  expectedLocalActions = [],
  expectedModel,
  expectedPublisherScript,
  expectedSecrets,
  expectedAuthoritySha256,
}) {
  const violations = [];
  if (!sameValues(authority.triggers, ["issue_comment", "issues"])) {
    violations.push("workflow must use only issues and issue_comment");
  }
  if (authority.metadata.strict !== true) {
    violations.push("compiler strict mode is required");
  }
  const authoritySha256 =
    expectedAuthoritySha256 ??
    RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE[expectedEngine];
  if (
    !authoritySha256 ||
    issueTriageAuthorityDigest(authority) !== authoritySha256
  ) {
    violations.push(
      "issue triage workflow differs from the approved authority inventory",
    );
  }
  if (JSON.stringify(authority.workflowEnv ?? {}) !== JSON.stringify({})) {
    violations.push("issue triage workflow environment must remain empty");
  }
  const approvedSecrets = expectedSecrets ?? issueTriageSecrets(expectedEngine);
  if (
    !approvedSecrets ||
    !sameValues(authority.secrets, approvedSecrets) ||
    !sameValues(authority.manifestSecrets, approvedSecrets)
  ) {
    violations.push("issue triage secrets differ from the approved inventory");
  }
  if (
    authority.metadata.agent_id !== expectedEngine ||
    authority.metadata.agent_model !== expectedModel
  ) {
    violations.push("issue triage model differs from the configured model");
  }
  if (!authority.inlinedImports) {
    violations.push("issue triager import must be inlined");
  }
  if (!sameValues(authority.resolvedImports, expectedImports)) {
    violations.push("resolved native imports must contain only issue-triager");
  }
  if (authority.runtimeImports.length > 0) {
    violations.push("runtime prompt imports are not allowed");
  }
  if (authority.unpinnedActions.length > 0) {
    violations.push("all actions must use immutable commit pins");
  }
  if (authority.unpinnedContainers.length > 0) {
    violations.push("all containers must use immutable digest pins");
  }
  if (!sameValues(authority.localActions, expectedLocalActions)) {
    violations.push("local actions differ from the approved inventory");
  }
  if (authority.additionalRepositories.length > 0) {
    violations.push("additional repository checkouts are not allowed");
  }
  if (
    authority.checkouts.some(
      ({ repository, ref, path, persistCredentials }) =>
        repository !== null ||
        ref !== null ||
        path !== null ||
        persistCredentials !== false,
    )
  ) {
    violations.push(
      "checkouts must use the base context without persisted credentials",
    );
  }
  if (!issueWriteJobsOnly(authority.writeCapableJobs)) {
    violations.push(
      "only conclusion may use workflow write authority for cancellation",
    );
  }
  if (!issuePublisherOnly(authority.actions, expectedPublisherScript)) {
    violations.push(
      "issue triage publisher must target only the triggering repository and issue",
    );
  }
  if (!sameValues(authority.safeOutputJobs, ["safe_outputs"])) {
    violations.push("issue triage must use only the safe_outputs publisher");
  }
  if (!issueTriageSafeOutputsAreBounded(authority)) {
    violations.push(
      "issue triage safe outputs differ from the approved handler set and settings",
    );
  }
  return Object.freeze({
    trusted: violations.length === 0,
    baseContext: "issues event default branch",
    violations: Object.freeze(violations),
  });
}

function repairWriteJobsOnly(writeCapableJobs) {
  return (
    writeCapableJobs.length === 2 &&
    writeCapableJobs[0].job === "activation" &&
    JSON.stringify(writeCapableJobs[0].permissions) ===
      JSON.stringify({
        actions: "read",
        contents: "read",
        issues: "write",
        "pull-requests": "write",
      }) &&
    writeCapableJobs[1].job === "conclusion" &&
    JSON.stringify(writeCapableJobs[1].permissions) ===
      JSON.stringify({ actions: "write" })
  );
}

export function assessRepairTrust({
  authority,
  expectedEngine,
  expectedImports = [],
  expectedLocalActions = [],
  expectedModel,
  expectedValidationCommands = ["npm test"],
  expectedSecrets,
  expectedAuthoritySha256,
}) {
  const violations = [];
  if (!sameValues(authority.triggers, ["issue_comment"])) {
    violations.push("repair workflow must use only issue_comment");
  }
  if (authority.metadata.strict !== true) {
    violations.push("compiler strict mode is required");
  }
  if (
    authority.metadata.agent_id !== expectedEngine ||
    authority.metadata.agent_model !== expectedModel
  ) {
    violations.push("repair model differs from the configured model");
  }
  const authoritySha256 =
    expectedAuthoritySha256 ??
    RIVET_REPAIR_AUTHORITY_SHA256_BY_ENGINE[expectedEngine];
  if (
    !authoritySha256 ||
    repairAuthorityDigest(authority, expectedValidationCommands) !==
      authoritySha256
  ) {
    violations.push("repair workflow differs from the approved authority inventory");
  }
  if (!authority.inlinedImports) {
    violations.push("repair workflow and native imports must be inlined");
  }
  if (!sameValues(authority.resolvedImports, expectedImports)) {
    violations.push("repair native imports differ from the approved inventory");
  }
  if (authority.runtimeImports.length > 0) {
    violations.push("runtime prompt imports are not allowed");
  }
  if (authority.unpinnedActions.length > 0) {
    violations.push("all actions must use immutable commit pins");
  }
  if (authority.unpinnedContainers.length > 0) {
    violations.push("all containers must use immutable digest pins");
  }
  if (!sameValues(authority.localActions, expectedLocalActions)) {
    violations.push("repair local actions differ from the approved inventory");
  }
  const approvedSecrets = expectedSecrets ?? issueTriageSecrets(expectedEngine);
  if (
    !approvedSecrets ||
    !sameValues(authority.secrets, approvedSecrets) ||
    !sameValues(authority.manifestSecrets, approvedSecrets)
  ) {
    violations.push("repair secrets differ from the approved inventory");
  }
  if (JSON.stringify(authority.permissions) !== JSON.stringify({})) {
    violations.push("repair root permissions must remain empty");
  }
  if (authority.additionalRepositories.length > 0) {
    violations.push("additional repository checkouts are not allowed");
  }
  if (
    authority.checkouts.length === 0 ||
    authority.checkouts.some(
      ({ repository, ref, path, persistCredentials }) =>
        repository !== null ||
        ref !== null ||
        path !== null ||
        persistCredentials !== false,
    )
  ) {
    violations.push("repair checkouts must not persist credentials");
  }
  if (!repairWriteJobsOnly(authority.writeCapableJobs)) {
    violations.push("repair write authority differs from the approved inventory");
  }
  if (!sameValues(authority.safeOutputJobs, ["safe_outputs"])) {
    violations.push("repair must use only the safe_outputs publisher");
  }
  if (!issueTriageSafeOutputsAreBounded(authority)) {
    violations.push(
      "repair safe outputs differ from the approved handler set and settings",
    );
  }
  return Object.freeze({
    trusted: violations.length === 0,
    baseContext: "owner-authorized pull request repair",
    violations: Object.freeze(violations),
  });
}

export function assessPullRequestTargetTrust({
  authority,
  expectedEngine,
  expectedImports = [],
  expectedLocalActions = [],
  expectedModel,
  expectedIssueTriage = "automatic",
  expectedInlineFindings = true,
  expectedMaximumFindings = 8,
  expectedRequestChanges = false,
  expectedReviewAuthoritySha256,
}) {
  const violations = [];
  if (!["automatic", "disabled"].includes(expectedIssueTriage)) {
    violations.push("expected issue triage mode must be automatic or disabled");
  }
  const compiledModel = expectedModel;
  if (!sameValues(authority.triggers, ["pull_request_target"])) {
    violations.push("workflow must use only pull_request_target");
  }
  if (authority.metadata.strict !== true) {
    violations.push("compiler strict mode is required");
  }
  if (authority.manifest.has_pull_request_target !== true) {
    violations.push("compiler manifest must record pull_request_target");
  }
  if (
    authority.metadata.agent_id !== expectedEngine ||
    authority.metadata.agent_model !== compiledModel
  ) {
    violations.push("review model differs from the configured model");
  }
  if (!authority.inlinedImports) {
    violations.push("workflow and native imports must be inlined");
  }
  if (!sameValues(authority.resolvedImports, expectedImports)) {
    violations.push(
      "resolved native imports differ from the approved inventory",
    );
  }
  if (authority.runtimeImports.length > 0) {
    violations.push("runtime prompt imports are not allowed");
  }
  if (authority.unpinnedActions.length > 0) {
    violations.push("all actions must use immutable commit pins");
  }
  if (authority.unpinnedContainers.length > 0) {
    violations.push("all containers must use immutable digest pins");
  }
  if (!sameValues(authority.localActions, expectedLocalActions)) {
    violations.push("local actions differ from the approved inventory");
  }
  const reviewAuthoritySha256 =
    expectedReviewAuthoritySha256 ??
    RIVET_REVIEW_AUTHORITY_SHA256_BY_POLICY[
      [
        expectedIssueTriage,
        expectedInlineFindings ? "inline" : "summary",
        expectedRequestChanges ? "request-changes" : "comment",
        expectedEngine,
      ].join(":")
    ];
  if (
    !reviewAuthoritySha256 ||
    reviewAuthorityDigest(authority) !== reviewAuthoritySha256 ||
    !reviewWriteAuthorityIsNarrow(authority) ||
    !reviewSafeOutputsAreBounded(
      authority,
      expectedIssueTriage,
      expectedInlineFindings,
      expectedRequestChanges,
    ) ||
    (authority.safeOutputConfig?.create_pull_request_review_comment &&
      reviewInlineLimit(authority) !== expectedMaximumFindings)
  ) {
    violations.push("review workflow differs from the approved inventory");
  }
  if (
    authority.githubMcpEnabled ||
    (expectedEngine === "codex" && authority.shellToolDisabled !== true)
  ) {
    violations.push("model-driven repository reads must be disabled");
  }
  if (authority.additionalRepositories.length > 0) {
    violations.push("additional repository checkouts are not allowed");
  }
  if (
    authority.checkouts.length === 0 ||
    authority.checkouts.some(
      ({ repository, ref, path, persistCredentials }) =>
        repository !== null ||
        ref !== null ||
        path !== null ||
        persistCredentials !== false,
    )
  ) {
    violations.push(
      "checkouts must use the base context without persisted credentials",
    );
  }
  return Object.freeze({
    trusted: violations.length === 0,
    baseContext: "pull_request_target default branch",
    violations: Object.freeze(violations),
  });
}
