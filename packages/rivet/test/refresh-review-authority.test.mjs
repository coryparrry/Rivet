import assert from "node:assert/strict";
import test from "node:test";
import { replaceAuthorityDeclarations } from "../scripts/refresh-review-authority.mjs";

const ENGINES = ["claude", "codex", "copilot", "gemini"];
const hash = (character) => character.repeat(64);
const engineDeclaration = (name, character) =>
  `export const ${name} = Object.freeze({\n${ENGINES.map(
    (engine) => `  ${engine}: "${hash(character)}",`,
  ).join("\n")}\n});`;
const reviewDeclaration = (character) => {
  const keys = [];
  for (const triage of ["automatic", "disabled"])
    for (const inline of ["inline", "summary"])
      for (const decision of ["comment", "request-changes"])
        for (const engine of ENGINES)
          keys.push(`${triage}:${inline}:${decision}:${engine}`);
  return `export const RIVET_REVIEW_AUTHORITY_SHA256_BY_POLICY = Object.freeze({\n${keys
    .map((key) => `  "${key}": "${hash(character)}",`)
    .join("\n")}\n});`;
};
const scalarDeclaration = (name, character) =>
  `export const ${name} =\n  "${hash(character)}";`;

function declarations(character) {
  return {
    RIVET_REVIEW_AUTHORITY_SHA256_BY_POLICY: reviewDeclaration(character),
    RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE: engineDeclaration(
      "RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE",
      character,
    ),
    RIVET_MAINTENANCE_ACTIONS_SHA256: scalarDeclaration(
      "RIVET_MAINTENANCE_ACTIONS_SHA256",
      character,
    ),
    RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256: scalarDeclaration(
      "RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256",
      character,
    ),
    RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256: scalarDeclaration(
      "RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256",
      character,
    ),
    RIVET_REPAIR_AUTHORITY_SHA256_BY_ENGINE: engineDeclaration(
      "RIVET_REPAIR_AUTHORITY_SHA256_BY_ENGINE",
      character,
    ),
  };
}

test("replaces every generated authority declaration as one validated set", () => {
  const originalDeclarations = declarations("a");
  const source = `before\n${Object.values(originalDeclarations).join("\n")}\nafter\n`;
  const replacements = declarations("b");
  const updated = replaceAuthorityDeclarations(source, replacements);

  assert.equal(updated, `before\n${Object.values(replacements).join("\n")}\nafter\n`);
});

test("refuses incomplete, malformed, or duplicate authority inventories", () => {
  const original = declarations("a");
  const source = Object.values(original).join("\n");
  const incomplete = declarations("b");
  delete incomplete.RIVET_REPAIR_AUTHORITY_SHA256_BY_ENGINE;
  assert.throws(
    () => replaceAuthorityDeclarations(source, incomplete),
    /replacements are incomplete/,
  );

  const malformed = declarations("b");
  malformed.RIVET_MAINTENANCE_ACTIONS_SHA256 =
    "export const RIVET_MAINTENANCE_ACTIONS_SHA256 = \"not-a-digest\";";
  assert.throws(
    () => replaceAuthorityDeclarations(source, malformed),
    /must occur exactly once/,
  );

  assert.throws(
    () =>
      replaceAuthorityDeclarations(
        `${source}\n${original.RIVET_REPAIR_AUTHORITY_SHA256_BY_ENGINE}`,
        declarations("b"),
      ),
    /must occur exactly once/,
  );
});
