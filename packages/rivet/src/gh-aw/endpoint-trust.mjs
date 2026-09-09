import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { validateModelEndpoint } from "../model-endpoint.mjs";

const CONFIG_PREFIX = "printf '%s\\n' \"";
const CONFIG_SUFFIX = '\" > "${RUNNER_TEMP}/gh-aw/awf-config.json"';
const CREDITS_EXPRESSION = '"maxAiCredits":${GH_AW_MAX_AI_CREDITS}';
const MODEL_KEYS = new Set([
  "GH_AW_INFO_MODEL",
  "GH_AW_ENGINE_MODEL",
  "GH_AW_MODEL_AGENT_CODEX",
  "GH_AW_MODEL_DETECTION_CODEX",
]);

function fail() {
  throw new Error(
    "Rivet custom endpoint: compiled workflow differs from the configured endpoint and approved workflow",
  );
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function workflow(source) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) fail();
  return document.toJS({ maxAliasCount: 0 });
}

function header(source, name) {
  const prefix = `# gh-aw-${name}: `;
  const line = source.split("\n").find((entry) => entry.startsWith(prefix));
  if (!line) fail();
  return JSON.parse(line.slice(prefix.length));
}

function addHost(domains, host) {
  return [...new Set([...domains, host])].sort();
}

// Compare the JSON data separately from its shell quoting, preserving every
// surrounding command. The one numeric shell expansion must remain intact.
function proxyConfig(run, transform = (config) => config) {
  return run
    .split("\n")
    .map((line) => {
      if (!line.startsWith(CONFIG_PREFIX) || !line.endsWith(CONFIG_SUFFIX))
        return line;
      const quoted = line.slice(CONFIG_PREFIX.length, -CONFIG_SUFFIX.length);
      const json = quoted.replace(/\\(["\\$`])/g, "$1");
      const expectedQuoting = json
        .replace(/[\\"$`]/g, "\\$&")
        .replaceAll("\\${GH_AW_MAX_AI_CREDITS}", "${GH_AW_MAX_AI_CREDITS}");
      if (quoted !== expectedQuoting) fail();
      if (!json.includes(CREDITS_EXPRESSION)) fail();
      const normalizedJson = json.replace(
        CREDITS_EXPRESSION,
        '"maxAiCredits":null',
      );
      const config = JSON.parse(normalizedJson);
      if (parseDocument(normalizedJson, { uniqueKeys: true }).errors.length)
        fail();
      return `${CONFIG_PREFIX}${JSON.stringify(canonical(transform(config)))}${CONFIG_SUFFIX}`;
    })
    .join("\n");
}

function endpointSecrets(names, secret) {
  return [
    ...new Set([
      ...names.filter(
        (name) => !["CODEX_API_KEY", "OPENAI_API_KEY"].includes(name),
      ),
      secret,
    ]),
  ].sort();
}

function endpointEnvironment(env, { hostname, apiKeySecret, model }) {
  if (!env) return;
  for (const key of MODEL_KEYS) {
    if (Object.hasOwn(env, key)) env[key] = model;
  }
  if (env.GH_AW_INFO_ALLOWED_DOMAINS) {
    env.GH_AW_INFO_ALLOWED_DOMAINS = JSON.stringify([
      ...JSON.parse(env.GH_AW_INFO_ALLOWED_DOMAINS),
      hostname,
    ]);
  }
  if (env.GH_AW_ALLOWED_DOMAINS) {
    env.GH_AW_ALLOWED_DOMAINS = addHost(
      env.GH_AW_ALLOWED_DOMAINS.split(","),
      hostname,
    ).join(",");
  }
  if (env.GH_AW_SECRET_NAMES) {
    env.GH_AW_SECRET_NAMES = endpointSecrets(
      env.GH_AW_SECRET_NAMES.split(","),
      apiKeySecret,
    ).join(",");
    delete env.SECRET_CODEX_API_KEY;
    delete env.SECRET_OPENAI_API_KEY;
    env[`SECRET_${apiKeySecret}`] = `\${{ secrets.${apiKeySecret} }}`;
  }
}

function configuredWorkflow(source, endpoint, model) {
  const expected = workflow(source);
  const url = new URL(endpoint.baseUrl);
  const options = { ...endpoint, hostname: url.hostname, model };
  const secret = `\${{ secrets.${endpoint.apiKeySecret} }}`;
  const apiPath = url.pathname.replace(/\/$/, "");
  for (const [jobId, job] of Object.entries(expected.jobs)) {
    endpointEnvironment(job.env, options);
    for (const step of job.steps ?? []) {
      endpointEnvironment(step.env, options);
      if (step.id === "validate-secret") {
        step.env.CODEX_API_KEY = secret;
        step.env.OPENAI_API_KEY = secret;
      }
      if (
        ["agentic_execution", "detection_agentic_execution"].includes(step.id)
      ) {
        step.env.CODEX_API_KEY = secret;
        step.env.OPENAI_API_KEY = secret;
        step.env.OPENAI_BASE_URL = url.href;
        step.run = proxyConfig(step.run, (config) => {
          config.network.allowDomains = addHost(
            config.network.allowDomains,
            url.hostname,
          );
          config.apiProxy.targets = { openai: { host: url.hostname } };
          if (jobId === "agent") {
            config.apiProxy.modelFallback = { enabled: false };
            config.apiProxy.enableTokenSteering = false;
          }
          return config;
        });
        if (apiPath) {
          step.run = step.run.replace(
            "--skip-pull \\\n",
            `--skip-pull --openai-api-base-path ${apiPath} \\\n`,
          );
        }
      } else if (step.run) {
        step.run = proxyConfig(step.run);
      }
    }
  }
  return expected;
}

/** The baseline must separately pass Rivet's pinned authority checks. */
export function assertCustomEndpointWorkflow({
  source,
  baselineSource,
  endpoint,
  model,
}) {
  validateModelEndpoint(endpoint, "codex");
  const actual = workflow(source);
  for (const job of Object.values(actual.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.run) step.run = proxyConfig(step.run);
    }
  }
  if (
    !isDeepStrictEqual(
      actual,
      configuredWorkflow(baselineSource, endpoint, model),
    )
  )
    fail();
  const metadata = header(source, "metadata");
  const expectedMetadata = header(baselineSource, "metadata");
  if (!/^[a-f0-9]{64}$/.test(metadata.frontmatter_hash)) fail();
  expectedMetadata.frontmatter_hash = metadata.frontmatter_hash;
  expectedMetadata.agent_model = model;
  const manifest = header(baselineSource, "manifest");
  manifest.secrets = endpointSecrets(manifest.secrets, endpoint.apiKeySecret);
  if (
    !isDeepStrictEqual(metadata, expectedMetadata) ||
    !isDeepStrictEqual(header(source, "manifest"), manifest)
  )
    fail();
}
