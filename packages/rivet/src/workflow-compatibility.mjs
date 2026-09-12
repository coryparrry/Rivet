import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { applyUsageCachePolicy } from "./gh-aw/usage-cache.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

export function knownInstallationReceiptUpgrade(
  relativePath,
  current,
  planned,
) {
  if (relativePath !== ".github/rivet/installation.json") return false;
  try {
    const currentReceipt = JSON.parse(current);
    const plannedReceipt = JSON.parse(planned);
    if (
      !currentReceipt ||
      Array.isArray(currentReceipt) ||
      !plannedReceipt ||
      Array.isArray(plannedReceipt)
    ) {
      return false;
    }
    delete currentReceipt.compiler;
    delete plannedReceipt.compiler;
    return isDeepStrictEqual(
      canonical(currentReceipt),
      canonical(plannedReceipt),
    );
  } catch {
    return false;
  }
}

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
