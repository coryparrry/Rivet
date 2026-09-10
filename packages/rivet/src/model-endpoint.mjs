import { isIP } from "node:net";

const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/;
const HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BASE_URL = /^https:\/\/[A-Za-z0-9.-]+(?::443)?(?:\/[A-Za-z0-9._~/-]*)?$/;

export function validateModelEndpoint(endpoint, engine) {
  const fail = (message) => {
    throw new Error(`Rivet config: models.review.endpoint ${message}`);
  };
  if (engine !== "codex") fail("requires the codex engine");
  if (
    !endpoint ||
    typeof endpoint !== "object" ||
    Array.isArray(endpoint) ||
    Object.keys(endpoint).sort().join(",") !== "apiKeySecret,baseUrl"
  ) {
    fail("must contain only baseUrl and apiKeySecret");
  }
  if (
    typeof endpoint.baseUrl !== "string" ||
    endpoint.baseUrl.length > 2048 ||
    !BASE_URL.test(endpoint.baseUrl)
  ) {
    fail(
      "baseUrl must be an HTTPS URL without credentials, query, or fragment",
    );
  }
  let url;
  try {
    url = new URL(endpoint.baseUrl);
  } catch {
    fail("baseUrl must be a valid HTTPS URL");
  }
  if (!HOSTNAME.test(url.hostname) || isIP(url.hostname) || url.port) {
    fail("baseUrl must use a DNS hostname and the default HTTPS port");
  }
  if (/\/(?:\.|\.\.)(?:\/|$)/.test(endpoint.baseUrl)) {
    fail("baseUrl must not contain dot path segments");
  }
  if (
    typeof endpoint.apiKeySecret !== "string" ||
    !SECRET_NAME.test(endpoint.apiKeySecret) ||
    /^(?:GITHUB_|GH_|RIVET_APP_)/.test(endpoint.apiKeySecret) ||
    endpoint.apiKeySecret === "COPILOT_GITHUB_TOKEN"
  ) {
    fail(
      "apiKeySecret must name a model credential, not a GitHub or Rivet App credential",
    );
  }
  return endpoint;
}

export function modelEngineFrontmatter({ engine, model, endpoint }) {
  if (!endpoint) return `engine: ${engine}\nmodel: ${model}\n`;
  validateModelEndpoint(endpoint, engine);
  const secret = `\${{ secrets.${endpoint.apiKeySecret} }}`;
  const url = new URL(endpoint.baseUrl);
  return `engine:
  id: codex
  env:
    OPENAI_BASE_URL: ${JSON.stringify(url.href)}
    CODEX_API_KEY: ${secret}
    OPENAI_API_KEY: ${secret}
model: ${model}
network:
  allowed:
    - defaults
    - ${url.hostname}
sandbox:
  agent:
    model-fallback: false
    token-steering: false
`;
}
