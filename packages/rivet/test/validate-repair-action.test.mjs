import assert from "node:assert/strict";
import test from "node:test";
import { runValidateRepairAction } from "../assets/repair/.github/rivet/actions/validate-repair/index.mjs";

const patch = [
  "diff --git a/src/discount.mjs b/src/discount.mjs",
  "index 1234567..89abcde 100644",
  "--- a/src/discount.mjs",
  "+++ b/src/discount.mjs",
  "@@ -1 +1 @@",
  "-export const valid = false;",
  "+export const valid = true;",
  "",
].join("\n");

const event = {
  repository: { full_name: "owner/repository" },
  issue: {
    number: 12,
    pull_request: { url: "https://api.github.com/pulls/12" },
  },
  comment: {
    id: 34,
    body: "/rivet-repair",
    author_association: "OWNER",
    created_at: "2026-08-27T12:00:00Z",
    user: { login: "owner" },
  },
};

test("emits an exact-head receipt after isolated validation", async () => {
  const headSha = "a".repeat(40);
  const pull = {
    head: {
      sha: headSha,
      ref: "repair-branch",
      repo: { full_name: "owner/repository" },
    },
  };
  const responses = [pull, pull];
  const calls = [];
  const written = new Map();
  const receipt = await runValidateRepairAction({
    env: {
      GITHUB_EVENT_PATH: "/event.json",
      GH_AW_AGENT_OUTPUT: "/output.json",
      GITHUB_WORKSPACE: "/workspace",
      RUNNER_TEMP: "/runner",
      GITHUB_TOKEN: "read-only-token",
      RIVET_VALIDATION_COMMANDS_BASE64: Buffer.from(
        JSON.stringify(["npm test"]),
      ).toString("base64"),
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => responses.shift(),
    }),
    readFileImpl: async (filePath) =>
      JSON.stringify(
        filePath === "/event.json"
          ? event
          : { items: [{ type: "validate_repair", patch }] },
      ),
    writeFileImpl: async (filePath, content) => written.set(filePath, content),
    mkdirImpl: async () => {},
    runImpl: async (command, args, options) => {
      calls.push([command, ...args]);
      if (command === "docker") {
        assert.equal(options.env.GITHUB_TOKEN, undefined);
        assert.equal(
          options.env.RIVET_VALIDATION_COMMANDS_BASE64,
          Buffer.from(JSON.stringify(["npm test"])).toString("base64"),
        );
        assert.ok(args.includes("--rm"));
        assert.ok(args.includes("--init"));
        assert.ok(args.includes("--cap-drop=ALL"));
        assert.ok(args.includes("--security-opt=no-new-privileges"));
        assert.ok(
          args.includes(
            "node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a",
          ),
        );
        assert.ok(
          args.includes("type=bind,source=/workspace,target=/workspace"),
        );
        assert.equal(args.at(-1), "npm test");
        assert.equal(args.includes("/runner"), false);
        assert.equal(args.includes("read-only-token"), false);
      }
      if (args[0] === "diff" && args.includes("--name-only")) {
        return "src/discount.mjs\0";
      }
      if (args[0] === "diff") return patch;
      return "";
    },
  });
  assert.equal(
    calls.some(([command, first]) => command === "docker" && first === "run"),
    true,
  );
  assert.equal(receipt.headSha, headSha);
  assert.deepEqual(receipt.validation, [{ command: "npm test", exitCode: 0 }]);
  assert.equal(written.get("/runner/rivet-repair/patch.diff"), patch);
  assert.match(
    written.get("/runner/rivet-repair/receipt.json"),
    /"schemaVersion":1/,
  );
});

test("rejects a headerless ignored-file creation before issuing a receipt", async () => {
  const headerlessIgnoredCreation = [
    patch.trimEnd(),
    "--- /dev/null",
    "+++ b/node_modules/injected.js",
    "@@ -0,0 +1 @@",
    "+injected",
    "",
  ].join("\n");
  let runCalls = 0;
  let writeCalls = 0;
  await assert.rejects(
    () =>
      runValidateRepairAction({
        env: {
          GITHUB_EVENT_PATH: "/event.json",
          GH_AW_AGENT_OUTPUT: "/output.json",
          GITHUB_WORKSPACE: "/workspace",
          RUNNER_TEMP: "/runner",
          GITHUB_TOKEN: "read-only-token",
        },
        fetchImpl: async () => {
          throw new Error("GitHub must not be contacted for an invalid patch");
        },
        readFileImpl: async (filePath) =>
          JSON.stringify(
            filePath === "/event.json"
              ? event
              : {
                  items: [
                    {
                      type: "validate_repair",
                      patch: headerlessIgnoredCreation,
                    },
                  ],
                },
          ),
        writeFileImpl: async () => {
          writeCalls += 1;
        },
        runImpl: async () => {
          runCalls += 1;
        },
      }),
    /unanchored unified diff section/,
  );
  assert.equal(runCalls, 0);
  assert.equal(writeCalls, 0);
});

test("rejects ignored files created during validation", async () => {
  const headSha = "a".repeat(40);
  const pull = {
    head: {
      sha: headSha,
      ref: "repair-branch",
      repo: { full_name: "owner/repository" },
    },
  };
  const responses = [pull, pull];
  const written = new Map();
  let ignoredSnapshot = 0;
  await assert.rejects(
    () =>
      runValidateRepairAction({
        env: {
          GITHUB_EVENT_PATH: "/event.json",
          GH_AW_AGENT_OUTPUT: "/output.json",
          GITHUB_WORKSPACE: "/workspace",
          RUNNER_TEMP: "/runner",
          GITHUB_TOKEN: "read-only-token",
          RIVET_VALIDATION_COMMANDS_BASE64: Buffer.from(
            JSON.stringify(["npm test"]),
          ).toString("base64"),
        },
        fetchImpl: async () => ({
          ok: true,
          json: async () => responses.shift(),
        }),
        readFileImpl: async (filePath) =>
          JSON.stringify(
            filePath === "/event.json"
              ? event
              : { items: [{ type: "validate_repair", patch }] },
          ),
        writeFileImpl: async (filePath, content) =>
          written.set(filePath, content),
        mkdirImpl: async () => {},
        runImpl: async (command, args, options) => {
          if (command === "docker") return "";
          if (command === "git" && args[0] === "diff") {
            return args.includes("--name-only") ? "src/discount.mjs\0" : patch;
          }
          if (command === "git" && args[0] === "ls-files") {
            if (args.includes("--ignored")) {
              ignoredSnapshot += 1;
              return ignoredSnapshot === 3 ? "node_modules/injected.js\0" : "";
            }
            return "";
          }
          if (command === "git" && args[0] === "hash-object") {
            return `${"0".repeat(40)}\n`.repeat(args.length - 2);
          }
          return "";
        },
      }),
    /unexpected ignored workspace paths/,
  );
  assert.equal(written.has("/runner/rivet-repair/receipt.json"), false);
});
