import path from "node:path";

export const MODEL_SECRETS = Object.freeze(["CODEX_API_KEY", "OPENAI_API_KEY"]);

export function sanitizedEnvironment(environment, additionalSecrets = []) {
  const env = { ...environment, GH_HOST: "github.com" };
  for (const name of [...MODEL_SECRETS, ...additionalSecrets, "GH_REPO"])
    delete env[name];
  const pathKey = Object.keys(env).find(
    (name) => name.toLowerCase() === "path",
  );
  if (pathKey && typeof env[pathKey] === "string") {
    env[pathKey] = env[pathKey]
      .split(path.delimiter)
      .filter((entry) => {
        if (!entry || !path.isAbsolute(entry)) return false;
        const normalized = entry
          .replaceAll("\\", "/")
          .replace(/\/+$/u, "")
          .toLowerCase();
        return (
          normalized !== "node_modules/.bin" &&
          !normalized.endsWith("/node_modules/.bin")
        );
      })
      .join(path.delimiter);
  }
  return env;
}

// The secret name is unknown until after locating and reading repository config.
// Git needs only OS lookup paths and locale for this local repository probe.
export function repositoryProbeEnvironment(environment) {
  const allowed = new Set([
    "PATH",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "SYSTEMROOT",
    "WINDIR",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "GH_HOST",
  ]);
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) =>
      allowed.has(name.toUpperCase()),
    ),
  );
}
