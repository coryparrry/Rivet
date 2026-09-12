import assert from "node:assert/strict";
import test from "node:test";
import { knownInstallationReceiptUpgrade } from "../src/workflow-compatibility.mjs";

const receipt = {
  schemaVersion: 1,
  product: "Rivet",
  mode: "review",
  compiler: {
    version: "0.86.2",
    commit: "current",
    actionsCommit: "current-actions",
  },
  githubApp: { permissions: { contents: "read" } },
  managedFiles: [".github/rivet/installation.json"],
};

test("accepts only compiler and formatting drift in installation receipts", () => {
  const previous = structuredClone(receipt);
  previous.compiler = {
    version: "0.80.0",
    commit: "previous",
    actionsCommit: "previous-actions",
  };
  assert.equal(
    knownInstallationReceiptUpgrade(
      ".github/rivet/installation.json",
      JSON.stringify(previous),
      `${JSON.stringify(receipt, null, 2)}\n`,
    ),
    true,
  );

  previous.githubApp.permissions.contents = "write";
  assert.equal(
    knownInstallationReceiptUpgrade(
      ".github/rivet/installation.json",
      JSON.stringify(previous),
      JSON.stringify(receipt),
    ),
    false,
  );
  assert.equal(
    knownInstallationReceiptUpgrade(
      ".github/rivet/installation.json",
      "not json",
      JSON.stringify(receipt),
    ),
    false,
  );
  assert.equal(
    knownInstallationReceiptUpgrade(
      ".github/rivet.json",
      JSON.stringify(previous),
      JSON.stringify(receipt),
    ),
    false,
  );
});
