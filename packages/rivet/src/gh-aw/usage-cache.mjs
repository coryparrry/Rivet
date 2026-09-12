import { parseDocument } from "yaml";

export const USAGE_CACHE_SAVE_CONDITION =
  "always() && github.event_name != 'pull_request_target'";

// gh-aw 0.86.2 unconditionally saves usage history. GitHub issues read-only
// default-branch cache tokens for pull_request_target; its artifact fallback
// must remain available instead. Keep every other compiled byte unchanged.
export function applyUsageCachePolicy(source) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw document.errors[0];
  if (!document.hasIn(["on", "pull_request_target"])) return source;
  const steps = document.getIn(["jobs", "conclusion", "steps"]);
  const matches =
    steps?.items?.filter((step) => step.get("id") === "save-daily-aic-cache") ??
    [];
  if (matches.length !== 1)
    throw new Error("Rivet usage cache: expected one conclusion save step");
  const step = matches[0];
  if (
    !/^actions\/cache\/save@[a-f0-9]{40}$/.test(step.get("uses")) ||
    step.getIn(["with", "path"]) !==
      "/tmp/gh-aw/agentic-workflow-usage-cache.jsonl"
  )
    throw new Error("Rivet usage cache: unexpected save action or path");
  const condition = step.get("if", true);
  if (condition?.value === USAGE_CACHE_SAVE_CONDITION) return source;
  if (condition?.value !== "always()" || !condition.range)
    throw new Error("Rivet usage cache: unexpected save condition");
  const [start, end] = condition.range;
  return (
    source.slice(0, start) + USAGE_CACHE_SAVE_CONDITION + source.slice(end)
  );
}
