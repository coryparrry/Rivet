import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { validateRivetConfig } from "./config.mjs";
import { completeInstallationFiles } from "./installation-receipt.mjs";
import { buildWorkflowFiles } from "./workflow-files.mjs";
import { PRE_REVIEW_STATUS_EXTENSION } from "./tagging-upgrade.mjs";

function installedReviewShape(source) {
  if (typeof source !== "string") return null;
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatter) return null;
  const document = parseDocument(frontmatter[1], { uniqueKeys: true });
  if (document.errors.length) return null;
  const value = document.toJS({ maxAliasCount: 0 });
  const safeOutputs = value["safe-outputs"];
  const inline = safeOutputs?.["create-pull-request-review-comment"];
  const allowedEvents = safeOutputs?.["submit-pull-request-review"]?.[
    "allowed-events"
  ];
  const model = {
    engine: typeof value.engine === "string" ? value.engine : value.engine?.id,
    model: value.model,
    effort: "default",
  };
  if (typeof value.engine === "object") {
    const env = value.engine?.env;
    const secret =
      typeof env?.CODEX_API_KEY === "string"
        ? env.CODEX_API_KEY.match(
            /^\$\{\{ secrets\.([A-Z_][A-Z0-9_]*) \}\}$/,
          )?.[1]
        : null;
    if (!secret || env?.OPENAI_API_KEY !== env.CODEX_API_KEY) return null;
    model.endpoint = { baseUrl: env.OPENAI_BASE_URL, apiKeySecret: secret };
  }
  return {
    model,
    review: {
      automatic: true,
      inlineFindings: Boolean(inline),
      requestChanges:
        Array.isArray(allowedEvents) && allowedEvents.includes("REQUEST_CHANGES"),
      maximumFindings: Number.isInteger(inline?.max) ? inline.max : null,
    },
    issueTriage: Boolean(safeOutputs?.["create-issue"]),
    includeAutoTagging: Boolean(value.jobs?.review_tags_pending),
    includeFailureSafePendingTags:
      value.jobs?.agent?.if === "needs.review_context.outputs.snapshot != ''",
    includePendingTagOutput:
      value.jobs?.review_tags_pending?.outputs?.output ===
      "${{ steps.pending-tags.outcome }}",
    useClientIdInput: Boolean(
      value.jobs?.review_tags_pending?.steps?.find(
        (step) => step.id === "review-token",
      )?.with?.["client-id"],
    ),
  };
}

// Reconstruct only model settings, then require the complete installed files
// to match this freshly rendered baseline before permitting any overwrite.
export async function buildModelConfigurationBaseline({
  previousSource,
  previousConfigurationContent,
  ...options
}) {
  const previous = installedReviewShape(previousSource);
  const previousModel = previous?.model;
  if (!previousModel || !previous.review) return null;
  let storedConfig = null;
  try {
    storedConfig = previousConfigurationContent
      ? validateRivetConfig(JSON.parse(previousConfigurationContent))
      : null;
  } catch {
    storedConfig = null;
  }
  const previousReview = {
    ...previous.review,
    maximumFindings:
      previous.review.maximumFindings ??
      storedConfig?.review.maximumFindings ??
      options.config.review.maximumFindings,
  };
  const previousIssueTriage = previous.issueTriage ? "automatic" : "disabled";
  if (
    isDeepStrictEqual(previousModel, options.config.models.review) &&
    isDeepStrictEqual(previousReview, options.config.review) &&
    previousIssueTriage === options.config.issues.triage
  ) {
    return null;
  }
  let config;
  try {
    config = storedConfig ?? structuredClone(options.config);
    config = structuredClone(config);
    config.models.review = previousModel;
    config.review = previousReview;
    config.issues.triage = previousIssueTriage;
    validateRivetConfig(config);
  } catch {
    return null;
  }
  const reviewConfig = structuredClone(config);
  reviewConfig.repair.authority = "never";
  const mode = config.repair.authority === "owner" ? "repair" : "review";
  const files = await buildWorkflowFiles({
    ...options,
    mode,
    config,
    reviewConfig,
    profiles: true,
    includeAutoTagging: previous.includeAutoTagging,
    includeFailureSafePendingTags: previous.includeFailureSafePendingTags,
    includePendingTagOutput: previous.includePendingTagOutput,
    useClientIdInput: previous.useClientIdInput,
    reviewExtension: previous.includeFailureSafePendingTags
      ? previous.useClientIdInput
        ? undefined
        : await readFile(PRE_REVIEW_STATUS_EXTENSION, "utf8")
      : await readFile(
          new URL(
            "../assets/upgrades/pre-pending-tag-isolation/review-extension.md",
            import.meta.url,
          ),
          "utf8",
        ),
    includeIssueTriage: config.issues.triage === "automatic",
    includeMaintenance: config.maintenance.mode !== "disabled",
  });
  completeInstallationFiles(files, { mode, config });
  // The config is the user's validated input. Workflow and receipt matching
  // still establish the prior installation before any managed file is replaced.
  if (previousConfigurationContent)
    files.set(".github/rivet.json", previousConfigurationContent);
  return files;
}
