import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { applyUsageCachePolicy } from "./gh-aw/usage-cache.mjs";

export function knownUsageCacheUpgrade(relativePath, current, planned) {
  if (!relativePath.endsWith(".lock.yml")) return false;
  try {
    const adjusted = applyUsageCachePolicy(current);
    return (
      adjusted !== current &&
      knownCompilerDrift(relativePath, adjusted, planned)
    );
  } catch {
    return false;
  }
}

export function knownCompilerDrift(relativePath, current, planned) {
  if (!relativePath.endsWith(".lock.yml")) return false;
  try {
    return isDeepStrictEqual(parseYaml(current), parseYaml(planned));
  } catch {
    return false;
  }
}

export function matchesWorkflowBaseline(relativePath, current, baseline) {
  const planned = baseline.get(relativePath);
  return (
    planned === current ||
    (planned !== undefined &&
      (knownCompilerDrift(relativePath, current, planned) ||
        knownUsageCacheUpgrade(relativePath, current, planned)))
  );
}
