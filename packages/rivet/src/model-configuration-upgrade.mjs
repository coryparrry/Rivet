import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { validateRivetConfig } from "./config.mjs";
import { completeInstallationFiles } from "./installation-receipt.mjs";
import { buildWorkflowFiles } from "./workflow-files.mjs";

function installedModel(source) {
  if (typeof source !== "string") return null;
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatter) return null;
  const document = parseDocument(frontmatter[1], { uniqueKeys: true });
  if (document.errors.length) return null;
  const value = document.toJS({ maxAliasCount: 0 });
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
  return model;
}

// Reconstruct only model settings, then require the complete installed files
// to match this freshly rendered baseline before permitting any overwrite.
export async function buildModelConfigurationBaseline({
  previousSource,
  previousConfigurationContent,
  ...options
}) {
  const previousModel = installedModel(previousSource);
  if (
    !previousModel ||
    isDeepStrictEqual(previousModel, options.config.models.review)
  )
    return null;
  let config;
  try {
    config = previousConfigurationContent
      ? validateRivetConfig(JSON.parse(previousConfigurationContent))
      : structuredClone(options.config);
    config = structuredClone(config);
    config.models.review = previousModel;
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
