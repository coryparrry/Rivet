import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import { ensureGhAwBinary } from "../src/gh-aw/binary.mjs";
import {
  compileGhAwWorkflow,
  validateGhAwWorkflow,
} from "../src/gh-aw/compile.mjs";
import { inspectCompiledWorkflow } from "../src/gh-aw/inspect.mjs";
import { reviewAuthorityDigest } from "../src/gh-aw/trust.mjs";
import { renderRivetReviewWorkflow } from "../src/workflows/review.mjs";

// Regenerate from the pinned compiler, never from an untrusted candidate lock.
export async function refreshReviewAuthority({ write = false } = {}) {
  const binaryPath = await ensureGhAwBinary();
  const trustPath = new URL("../src/gh-aw/trust.mjs", import.meta.url);
  const original = await readFile(trustPath, "utf8");
  let updated = original;
  for (const triage of ["automatic", "disabled"]) {
    const hashes = {};
    for (const engine of ["claude", "codex", "copilot", "gemini"]) {
      const repositoryRoot = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "rivet-review-authority-")),
      );
      try {
        await cp(
          new URL("../assets/review/", import.meta.url),
          repositoryRoot,
          { recursive: true },
        );
        await mkdir(path.join(repositoryRoot, ".github/rivet/agents"), {
          recursive: true,
        });
        await mkdir(path.join(repositoryRoot, ".github/workflows"), {
          recursive: true,
        });
        await cp(
          new URL("../assets/agents/pr-reviewer.md", import.meta.url),
          path.join(repositoryRoot, ".github/rivet/agents/pr-reviewer.md"),
        );
        const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
        configuration.issues.triage = triage;
        configuration.models.review.engine = engine;
        if (engine !== "codex")
          configuration.models.review.model = `${engine}-review-model`;
        await writeFile(
          path.join(repositoryRoot, ".github/workflows/rivet-review.md"),
          renderRivetReviewWorkflow({ configuration }),
        );
        await compileGhAwWorkflow({
          repositoryRoot,
          workflowId: "rivet-review",
          binaryPath,
        });
        await validateGhAwWorkflow({
          repositoryRoot,
          workflowId: "rivet-review",
          binaryPath,
        });
        const source = await readFile(
          path.join(repositoryRoot, ".github/workflows/rivet-review.lock.yml"),
          "utf8",
        );
        hashes[engine] = reviewAuthorityDigest(inspectCompiledWorkflow(source));
      } finally {
        await rm(repositoryRoot, { recursive: true, force: true });
      }
    }
    const name = `RIVET_REVIEW_${triage === "disabled" ? "DISABLED_" : ""}AUTHORITY_SHA256_BY_ENGINE`;
    const pattern = new RegExp(
      `export const ${name} = Object.freeze\\(\\{[\\s\\S]*?\\}\\);`,
    );
    if (!pattern.test(updated))
      throw new Error(`Missing review inventory: ${name}`);
    updated = updated.replace(
      pattern,
      `export const ${name} = Object.freeze({\n${Object.entries(hashes)
        .map(([engine, hash]) => `  ${engine}: "${hash}",`)
        .join("\n")}\n});`,
    );
  }
  if (write) await writeFile(trustPath, updated);
  else if (updated !== original)
    throw new Error(
      "Review authority inventories differ from pinned compiler output",
    );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--write") || args.length > 1)
    throw new Error("usage: refresh-review-authority.mjs [--write]");
  await refreshReviewAuthority({ write: args.includes("--write") });
  process.stdout.write(
    "Verified review authority inventories for four engines and two triage modes\n",
  );
}
