import { createHash } from "node:crypto";
import { DEFAULT_RIVET_CONFIG } from "../config.mjs";
import { normalizeValidationCommands } from "../validation-runner.mjs";

export function sameValues(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function hasExactlyKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function maintenanceEnvironment(env, authority) {
  const modelKeys = new Set([
    "GH_AW_INFO_MODEL",
    "GH_AW_ENGINE_MODEL",
    "GH_AW_MODEL_AGENT_CODEX",
    "GH_AW_MODEL_DETECTION_CODEX",
  ]);
  return Object.fromEntries(
    Object.entries(env ?? {}).map(([key, value]) => [
      key,
      modelKeys.has(key)
        ? value === authority.metadata?.agent_model
          ? DEFAULT_RIVET_CONFIG.models.review.model
          : null
        : value,
    ]),
  );
}

function maintenanceActionInventory(authority) {
  return {
    actions: (authority.actions ?? []).map(
      ({ env, if: condition, job, uses, with: actionWith }) => ({
        env: maintenanceEnvironment(env, authority),
        if: condition ?? null,
        job,
        uses,
        with: actionWith ?? {},
      }),
    ),
    scripts: (authority.scripts ?? []).map(
      ({ env, if: condition, job, name, run, shell }) => ({
        job,
        name,
        if: condition,
        run,
        shell,
        env: maintenanceEnvironment(env, authority),
      }),
    ),
  };
}

function maintenanceJobAuthorityInventory(authority) {
  return {
    jobs: Object.fromEntries(
      Object.entries(authority.jobAuthority ?? {}).map(
        ([job, { container, env, environment, permissions, runsOn, services }]) => [
          job,
          {
            container,
            env: maintenanceEnvironment(env, authority),
            environment,
            permissions,
            runsOn,
            services,
          },
        ],
      ),
    ),
    workflowEnv: maintenanceEnvironment(authority.workflowEnv, authority),
  };
}

function normalizedSafeOutputConfig(config) {
  if (!config) return "";
  const normalized = structuredClone(config);
  normalized.create_issue = "<ISSUE_TRIAGE>";
  normalized.create_pull_request_review_comment = "<INLINE_FINDINGS>";
  if (normalized.submit_pull_request_review) {
    normalized.submit_pull_request_review.allowed_events = "<REVIEW_EVENTS>";
  }
  return JSON.stringify(normalized);
}

export function reviewInlineLimit(authority) {
  const maximum =
    authority.safeOutputConfig?.create_pull_request_review_comment?.max;
  return Number.isInteger(maximum) && maximum >= 1 && maximum <= 20
    ? maximum
    : null;
}

function normalizeReviewText(name, value, authority) {
  const maximum = reviewInlineLimit(authority);
  if (maximum === null || typeof value !== "string") return value;
  if (name.startsWith("GH_AW_PROMPT_CONTENT_")) {
    return value
      .replaceAll(
        `create_pull_request_review_comment(max:${maximum})`,
        "create_pull_request_review_comment(max:8)",
      )
      .replaceAll(
        `Publish no more than ${maximum} inline findings.`,
        "Publish no more than 8 inline findings.",
      );
  }
  if (name === "GH_AW_TOOLS_META_JSON") {
    return value.replaceAll(
      `Maximum ${maximum} review comment(s) can be created.`,
      "Maximum 8 review comment(s) can be created.",
    );
  }
  return value;
}

function normalizeReviewScript(run, authority) {
  const maximum = reviewInlineLimit(authority);
  if (maximum === null || typeof run !== "string") return run;
  return run.replace(
    /'(GH_AW_SAFE_OUTPUTS_CONFIG_[0-9a-f]{16}_EOF)'\n([^\n]+)\n\1\n/g,
    (original, delimiter, source) => {
      let config;
      try {
        config = JSON.parse(source);
      } catch {
        return original;
      }
      if (config?.create_pull_request_review_comment?.max !== maximum)
        return original;
      config.create_pull_request_review_comment.max = 8;
      return `'GH_AW_SAFE_OUTPUTS_CONFIG_NORMALIZED_EOF'\n${JSON.stringify(config)}\nGH_AW_SAFE_OUTPUTS_CONFIG_NORMALIZED_EOF\n`;
    },
  );
}

function normalizeReviewEnv(env, authority) {
  const model = authority.metadata?.agent_model;
  const config = authority.safeOutputConfig
    ? JSON.stringify(authority.safeOutputConfig)
    : "";
  return Object.fromEntries(
    Object.entries(env ?? {}).map(([name, value]) => [
      name,
      value === model
        ? "<MODEL>"
        : name === "GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG" && value === config
          ? normalizedSafeOutputConfig(authority.safeOutputConfig)
          : normalizeReviewText(name, value, authority),
    ]),
  );
}

function reviewAuthorityInventory(authority) {
  const publicationJobs = new Set(["conclusion", "safe_outputs"]);
  const actions = (authority.actions ?? []).map((originalAction) => {
    const action = {
      ...originalAction,
      env: normalizeReviewEnv(originalAction.env, authority),
    };
    return publicationJobs.has(action.job) &&
      action.action === "actions/create-github-app-token"
      ? {
          ...action,
          with: {
            ...action.with,
            "permission-issues": "<ISSUES_PERMISSION>",
          },
        }
      : action;
  });
  const jobAuthority = Object.fromEntries(
    Object.entries(authority.jobAuthority ?? {}).map(([job, value]) => {
      const normalizedValue = value
        ? { ...value, env: normalizeReviewEnv(value.env, authority) }
        : value;
      return [
        job,
        normalizedValue && publicationJobs.has(job)
          ? {
              ...normalizedValue,
              permissions: {
                ...normalizedValue.permissions,
                issues: "<ISSUES_PERMISSION>",
              },
            }
          : normalizedValue,
      ];
    }),
  );
  return {
    actions,
    containers: authority.containers ?? [],
    jobAuthority,
    jobConditions: authority.jobConditions ?? {},
    jobIds: Object.keys(authority.jobAuthority ?? {}).sort(),
    permissions: authority.permissions ?? {},
    scripts: (authority.scripts ?? []).map((script) => ({
      ...script,
      run: normalizeReviewScript(script.run, authority),
      env: normalizeReviewEnv(script.env, authority),
    })),
    triggerConfig: authority.triggerConfig ?? {},
    workflowConcurrency: authority.concurrency ?? null,
    workflowDefaults: authority.workflowDefaults ?? null,
    workflowEnv: normalizeReviewEnv(authority.workflowEnv, authority),
  };
}

export function reviewAuthorityDigest(authority) {
  return digest(reviewAuthorityInventory(authority));
}

function issueTriageAuthorityInventory(authority) {
  const normalize = (value) => normalizeReviewEnv(value, authority);
  return {
    actions: (authority.actions ?? []).map((action) => ({
      ...action,
      env: normalize(action.env),
    })),
    containers: authority.containers ?? [],
    jobAuthority: Object.fromEntries(
      Object.entries(authority.jobAuthority ?? {}).map(([job, value]) => [
        job,
        value ? { ...value, env: normalize(value.env) } : value,
      ]),
    ),
    jobConditions: authority.jobConditions ?? {},
    jobIds: Object.keys(authority.jobAuthority ?? {}).sort(),
    permissions: authority.permissions ?? {},
    scripts: (authority.scripts ?? []).map((script) => ({
      ...script,
      env: normalize(script.env),
    })),
    triggerConfig: authority.triggerConfig ?? {},
    workflowConcurrency: authority.concurrency ?? null,
    workflowDefaults: authority.workflowDefaults ?? null,
    workflowEnv: normalize(authority.workflowEnv),
  };
}

export function issueTriageAuthorityDigest(authority) {
  return digest(issueTriageAuthorityInventory(authority));
}

export function maintenanceAuthorityDigests(authority) {
  return Object.freeze({
    actions: digest(maintenanceActionInventory(authority)),
    jobConditions: digest(authority.jobConditions ?? {}),
    jobAuthority: digest(maintenanceJobAuthorityInventory(authority)),
  });
}

function repairAuthorityInventory(authority, expectedValidationCommands) {
  const encodedValidationCommands = Buffer.from(
    JSON.stringify(normalizeValidationCommands(expectedValidationCommands)),
  ).toString("base64");
  const normalize = (env) => {
    const normalized = normalizeReviewEnv(env, authority);
    if (
      normalized.RIVET_VALIDATION_COMMANDS_BASE64 === encodedValidationCommands
    ) {
      normalized.RIVET_VALIDATION_COMMANDS_BASE64 = "<VALIDATION_COMMANDS>";
    }
    return normalized;
  };
  return {
    actions: (authority.actions ?? []).map((action) => ({
      ...action,
      env: normalize(action.env),
    })),
    containers: authority.containers ?? [],
    jobAuthority: Object.fromEntries(
      Object.entries(authority.jobAuthority ?? {}).map(([job, value]) => [
        job,
        value ? { ...value, env: normalize(value.env) } : value,
      ]),
    ),
    jobConditions: authority.jobConditions ?? {},
    jobIds: Object.keys(authority.jobAuthority ?? {}).sort(),
    permissions: authority.permissions ?? {},
    scripts: (authority.scripts ?? []).map((script) => ({
      ...script,
      env: normalize(script.env),
    })),
    triggerConfig: authority.triggerConfig ?? {},
    workflowConcurrency: authority.concurrency ?? null,
    workflowDefaults: authority.workflowDefaults ?? null,
    workflowEnv: normalize(authority.workflowEnv),
  };
}

export function repairAuthorityDigest(authority, expectedValidationCommands) {
  return digest(repairAuthorityInventory(authority, expectedValidationCommands));
}
