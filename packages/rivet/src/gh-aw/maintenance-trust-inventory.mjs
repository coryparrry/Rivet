// These hashes bind the complete compiled shape produced by the pinned gh-aw
// release. They are intentionally not derived from the candidate authority.
export const RIVET_MAINTENANCE_ACTIONS_SHA256_BY_ENGINE = Object.freeze({
  claude: "9a45aa6d181f5198f7c68a01f6af1ef4b7e0d3ebc50ed7af925ca2d2bb542ba2",
  codex: "ad7df34683b3ab83e39cb0fce683600ce04877c42d4d80778def9d58d25c1ad5",
  copilot: "e704ba14a5bac349fa87261f3fb44374e170315952e3e02da7eda8998288dbe5",
  gemini: "44f87986503906615218ecf17c20643f00940df1b4f2be40dc9e8c1b38d59b8f",
});
export const RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256_BY_ENGINE = Object.freeze({
  claude: "dcb9f93ac56879b15276b6cb780245b284ea25590ee5e299f7174063a80c3291",
  codex: "dcb9f93ac56879b15276b6cb780245b284ea25590ee5e299f7174063a80c3291",
  copilot: "dcb9f93ac56879b15276b6cb780245b284ea25590ee5e299f7174063a80c3291",
  gemini: "dcb9f93ac56879b15276b6cb780245b284ea25590ee5e299f7174063a80c3291",
});
export const RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256_BY_ENGINE = Object.freeze({
  claude: "74b5d1f0163c93c16b6a7a44aee902ba4f529433bdc0a08748cfad74184771dc",
  codex: "74b5d1f0163c93c16b6a7a44aee902ba4f529433bdc0a08748cfad74184771dc",
  copilot: "74b5d1f0163c93c16b6a7a44aee902ba4f529433bdc0a08748cfad74184771dc",
  gemini: "dea3215d7a84088375909b4255ff679ebaa7a552d57546ba9ec49b304f2a6cc6",
});

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

const MAINTENANCE_ENGINES = new Set(["claude", "codex", "copilot", "gemini"]);

export function isApprovedMaintenanceEngine(expectedEngine) {
  return MAINTENANCE_ENGINES.has(expectedEngine);
}

export function maintenanceSecrets(expectedEngine) {
  const provider = MAINTENANCE_PROVIDER_SECRETS[expectedEngine];
  if (!provider) return null;
  return [...new Set([...MAINTENANCE_SHARED_SECRETS, ...provider])].sort();
}

export function issueTriageSecrets(expectedEngine) {
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

export function maintenanceDigestForEngine(value, expectedEngine) {
  if (typeof value === "string") return value;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !isApprovedMaintenanceEngine(expectedEngine)
  ) {
    return null;
  }
  return value[expectedEngine] ?? null;
}
