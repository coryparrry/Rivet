# Rivet — full repository code review

Review mode: snapshot audit (whole repository). Read-only; the only change is this file.
Snapshot: `2725588bcc613441870fcf12ca4cb4240a98f9e3` on `codex/review-run-errors` (clean tree, no untracked files, no submodules). `origin/main` at `6432aa11`; HEAD is 4 ahead / 4 behind its merge base `13321cc7`.

Coordinator profile: DeepSeek (runtime `deepseek-flash`); reasoning level unknown → "Other/unknown" profile: no mixed-model substitution, at most two concurrent specialist lanes, no nesting, evidence-slice ceiling of 4 files / ~1,000 lines. Work was split into two read-only specialist lanes; every material candidate from those lanes was then re-validated by the coordinator against the frozen snapshot. A third independent omission-pass reviewer was launched with the coverage manifest only (no findings); see "Omission pass" below.

Verification that ran and passed: full `packages/rivet` suite (328 tests, 0 fail); root `lint`, `format:check`, `governance:check`, `architecture:check`; `bash scripts/release-source.sh --verify`. The pinned-compiler reproduction `npm --prefix packages/rivet run review-lock:check` could **not** run in this environment (see Evidence gaps).

---

## Findings (validated, highest priority first)

### 1. HIGH — Issue triage cannot be disabled on an existing installation
**Path:** `packages/rivet/src/install.mjs` (baselines at `:477-504`, `withoutIssueTriage` at `:131-140`, `plannedFiles` at `:697-754`), `packages/rivet/src/installation-receipt.mjs`.

**Trigger:** Install with the default policy (or any install with `issues.triage: "automatic"`), then run `rivet init --review-only --issues disabled` (or set `issues.triage: "disabled"` in `.github/rivet.json` and re-run).

**Violated invariant:** Documented in `CONFIGURATION.md:52-61` ("`disabled` installs no issue-triage workflow… the GitHub App needs no Issues permission"), `packages/rivet/README.md:80-83`, and the CLI help (`src/cli.mjs:30-33`, `--issues <disabled|automatic>`).

**Impact:** The refresh fails closed with `Rivet installer: refusing to overwrite .github/rivet.json` (or `.../installation.json` when the config is edited on disk first). All five managed triage files and the triage workflow remain installed, so there is no supported way to revoke triage authority. The App's Issues:write permission also stays required.

**Evidence (coordinator reproduction, this snapshot):** a temp repo installed with defaults via a fixture compiler, then planned with `issues.triage = "disabled"`:
```
[F2 editor, no prewrite] THREW: Rivet installer: refusing to overwrite .github/rivet.json
[F2 prewrite config] THREW: Rivet installer: refusing to overwrite .github/rivet/installation.json
```
Root cause: triage baselines (`withoutIssueTriage`, `buildIssueTriageUpgradeBaselines`) are built only when `config.issues.triage === "automatic"` (`:477`); nothing reconstructs the prior automatic-triage state when the new config is disabled, and `status: "delete"` is emitted only from `MAINTENANCE_MANAGED_PATHS` (`:732-746`). There is no triage analogue of the working maintenance-disable path.

**False-positive check:** Enabling triage (`disabled → automatic`) is covered and works (`issue-triage-upgrade.test.mjs:121`, `install.test.mjs:873`), so this is a one-directional gap, not a general upgrade failure. `cli.test.mjs:226-258` only exercises `--issues disabled` on a fresh dry-run.

**Fix direction:** mirror the maintenance-disable flow: a prior-automatic-triage baseline plus an `ISSUE_TRIAGE_MANAGED_PATHS` deletion list with the same exact-content guards before scheduling each `delete`.

**Missing test:** yes.

---

### 2. HIGH — Review policy cannot be changed on an existing installation
**Path:** `packages/rivet/src/install.mjs` (`baselines` `:280-683`, refusal `:710-714`); no baseline reconstructs prior `review.*` policy.

**Trigger:** Existing install; change `review.maximumFindings`, `review.inlineFindings`, or `review.requestChanges` in `.github/rivet.json`; re-run `rivet init --review-only` (the documented refresh flow, `CONFIGURATION.md:14-30`).

**Violated invariant:** These are validated, documented settings (`RIVET_SCHEMA_V4.md:57`, `CONFIGURATION.md:81-86`); the CLI and guided installer accept a custom finding limit at install time.

**Impact:** The refresh fails with `Rivet installer: refusing to overwrite .github/rivet/installation.json` (or the review workflow file). Review limits and comment behavior become immutable after install until managed files are removed by hand, even though `review.maximumFindings` is the primary documented review control.

**Evidence (coordinator reproduction):**
```
[F3 maxFindings->3 prewrite]     THREW: refusing to overwrite .github/rivet/installation.json
[F3 inlineFindings->false prewrite] THREW: refusing to overwrite .github/rivet/installation.json
```
`buildModelConfigurationBaseline` returns null when the model is unchanged (`model-configuration-upgrade.mjs:57-61`), and every other baseline is rendered from the *new* config, so none carries the prior policy.

**False-positive check:** Model changes, maintenance-mode changes, endpoint changes, and triage enablement each have a dedicated prior-state baseline; only the review policy has none. No test changes `review.*` on an existing install.

**Fix direction:** persist/reconstruct a prior-review-policy baseline whenever a rendered review field changes (same pattern as `buildModelConfigurationBaseline`).

**Missing test:** yes.

---

### 3. HIGH — Repair workflow ignores the configured non-endpoint engine and model
**Path:** `packages/rivet/src/workflows/repair.mjs:34-37`
```js
const configuredModel = validateRivetConfig(configuration).models.review;
const model = configuredModel.endpoint
  ? configuredModel
  : DEFAULT_RIVET_CONFIG.models.review;
```

**Trigger:** `rivet init --repair` (or `installRepair`) with `models.review.engine` set to `claude`, `copilot`, or `gemini` and no `endpoint`.

**Violated invariant:** `RIVET_SCHEMA_V4.md:43-55` documents all four engines as supported projections of a single `models.review` selection; review, triage, and maintenance render the configured engine.

**Impact:** The rendered repair workflow silently hard-codes `engine: codex` / `model: gpt-5.6-luna` (verified: the claude render is byte-identical to default). An owner-authorized repair run then targets the wrong provider: it normally fails at authentication, or, if a Codex credential is also present, sends the pull-request content to an unintended provider. Because repair has no compiled-authority assessment (finding 4), nothing detects the substitution.

**Evidence:** direct render with `{engine:"claude", model:"claude-sonnet-4-5"}` produced `engine: codex` / `model: gpt-5.6-luna`; default and claude renders compared equal. `git show 5da3734d` shows the ternary was introduced when endpoint routing was added; the previous code hard-coded codex unconditionally.

**False-positive check:** Endpoint-bearing configs do pick up the configured model; default Codex is unaffected. The schema explicitly supports the other engines, and no repair doc restricts repair to Codex (`grep` of `RIVET_REPAIR_QUALIFICATION.md` / `RIVET_REVIEW_ONLY_INSTALLER.md` finds no engine constraint).

**Fix direction:** use `configuredModel` unconditionally (as the other renderers do), and add prior-model repair baselines so existing Codex repair installs still upgrade cleanly; otherwise explicitly reject non-Codex repair at validation time.

**Missing test:** yes (no test renders repair with a non-default engine).

---

### 4. MEDIUM — The highest-authority workflow (repair) has no compiled-authority trust check
**Path:** `packages/rivet/src/installation-trust.mjs:33-105`; `packages/rivet/src/gh-aw/trust.mjs` (no `REPAIR` symbol).

**Trigger/condition:** Any repair install.

**Violated invariant:** Review, issue triage, and maintenance are each compared against an approved authority inventory/digest before the install plan is accepted; repair is not.

**Impact:** `assertInstallationTrust` contains zero repair references and `trust.mjs` has no `assessRepairTrust` or `RIVET_REPAIR_AUTHORITY_SHA256_BY_ENGINE`. A firmware/compiler change that widened the compiled repair workflow's permissions, actions, checkouts, or safe outputs would not be detected at install time, even though the equivalent change in review/triage/maintenance would be. Repair is the mode that holds Contents:write and publishes an App-authored commit.

**Evidence:** `grep -in repair src/installation-trust.mjs` → none; `grep -in REPAIR src/gh-aw/trust.mjs` → none; `grep -rin assessRepair\|REPAIR_AUTHORITY src/` → none.

**False-positive check:** The install still verifies the review/triage/maintenance authority and the repair renderer's bounded validation commands; the pinned compiler checksum is verified. This is a missing control, not a demonstrated exploit. Reported as a defense-in-depth gap.

**Fix direction:** add a repair authority inventory + per-engine digest and an `assessRepairTrust` call in `assertInstallationTrust`, as done for the other modes.

**Missing test:** yes.

---

### 5. MEDIUM — Issue-triage authority digest is blind to a handler-config-only safe-output drift
**Path:** `packages/rivet/src/gh-aw/trust.mjs`: `normalizedSafeOutputConfig` `:146-155`, `normalizeReviewEnv` `:208-222`, `issueTriageAuthorityInventory` `:285-311`, `assessIssueTriageTrust` `:603-700`. Review has the compensating check at `:356-415`.

**Trigger:** A compiled issue-triage workflow whose `GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG` env only differs from the pinned value by adding an unapproved handler such as `create_issue: {max: 9999}` (the shape a compiler/pin bump could produce).

**Violated invariant:** The authority digest must change when a new safe-output handler is introduced, or a separate bounds check must reject it (as `reviewSafeOutputsAreBounded` does for review).

**Impact:** `normalizedSafeOutputConfig` unconditionally rewrites `create_issue` to `"<ISSUE_TRIAGE>"` and `create_pull_request_review_comment` to `"<INLINE_FINDINGS>"`, and the handler env is replaced by that masked form, so the digest is byte-identical. `assessIssueTriageTrust` never reads `authority.safeOutputConfig`/`safeOutputSettings`, so an env-only widening passes both the pinned digest and install-time trust. Review catches the same class via `reviewSafeOutputsAreBounded`.

**Evidence (coordinator reproduction, issue-triage fixture):**
```
baseline violations: []
handler-env-only create_issue violations: []            <-- not flagged
consistent script+env create_issue violations: ["issue triage workflow differs from the approved authority inventory"]
```
The consistent change is caught only because the raw `config.json` script heredoc is hashed un-normalized; the env-only divergence is masked.

**False-positive check:** The realistic, fully consistent drift is detected, and mutating the raw script alone is detected. Practical exploitability requires the handler env to widen while the tool config does not, but the missing defense-in-depth is real and asymmetric with review.

**Fix direction:** in `assessIssueTriageTrust`, require `authority.safeOutputConfig` to match the approved handler set and `safeOutputSettings` to approved values (or forbid `create_issue`/`create_pull_request_review_comment` entirely), mirroring `reviewSafeOutputsAreBounded`.

**Missing test:** yes.

---

### 6. MEDIUM — Changed compiled `.lock.yml` files are unreviewable by design
**Path:** `packages/rivet/assets/review/.github/rivet/actions/prepare-review-context/index.mjs:144-152` (`hasCompletePatch`), `:154-156` (`ordinaryContextFile`), `:237-293` (`createRepositoryContext`); prompt allowance in `assets/review/.github/rivet/aw/review-extension.md:68`.

**Trigger:** A pull request changes `.github/workflows/<x>.lock.yml` so GitHub returns `patch: null` (large/generated file) together with any non-empty change to the sibling `<x>.md`.

**Violated invariant:** The review contract says the exact comparison is the proof for every in-PR finding (`review-extension.md:68`); yet a class of authority-bearing generated files has no diff and no blob.

**Impact:** `hasCompletePatch` accepts the lock solely because the `.md` has a complete patch, and `ordinaryContextFile` excludes every `*.lock.yml` from `repositoryContext`, so the reviewer never receives a single byte of the lock. A PR author can hand-edit a generated workflow lock (add steps, widen permissions, change triggers, exfiltrate secrets) alongside a benign `.md` change, and Rivet review has no technical evidence to substantiate a finding. The security property "the lock equals the compiler output of the reviewed `.md`" is asserted only in prompt text.

**Evidence:** `review-context-action.test.mjs:414-472` asserts the permissive behavior: a `patch: null` lock plus a changed `.md` yields `complete === true` and `files[0].patch === null`. No other control surfaces the lock: repository context excludes it, prior-review context is unrelated, and install-time `assertInstallationTrust` runs on installer-built files, not on pull requests.

**False-positive check:** The behavior is intentional and test-locked, and a lock whose `.md` source is also absent is correctly treated as incomplete. Reported as a review-integrity gap, not a crash.

**Fix direction:** fail closed when a changed `.lock.yml` has no returned patch, or fetch that blob (subject to the existing budgets) so the reviewer can diff it; alternatively recompile on a trusted runner and compare.

**Missing test:** yes (for the security expectation; the current test encodes the permissive behavior).

---

### 7. MEDIUM (process) — PR CI does not reproduce pinned-compiler outputs
**Path:** `.github/workflows/rivet-checks.yml:36-38` runs only `npm run check` (= `syntax` + `test`); `packages/rivet/package.json` `check` = `syntax && test`. `review-lock:check`/`release:check` run only in `.github/workflows/rivet-release.yml:48`.

**Impact:** A pull request that changes a workflow renderer can keep PR CI green while the compiled fixtures and the non-Codex review authority constants are stale; the failure appears only at release. Codex review digests are backed by a checked-in fixture asserted through `assessReview`, but Claude/Copilot/Gemini review digests and the issue-triage/maintenance constants are not re-derived in PR CI. Given this branch changed those constants, the gate gap is directly relevant.

**Fix direction:** run `npm --prefix packages/rivet run review-lock:check` (and, at least in a check-only mode, `node packages/rivet/scripts/refresh-review-authority.mjs`) in the PR checks job.

### 8. LOW–MEDIUM — Stale Codekeeper configuration and templates are still active
**Paths:** `.github/dependabot.yml:8` (`package-ecosystem: npm, directory: /tools/codekeeper`), `.github/ISSUE_TEMPLATE/bug.yml:2,14,22`, `.github/ISSUE_TEMPLATE/feature.yml:2`, `.github/CODEOWNERS:9`, `.github/actionlint.yaml:7`.

**Impact:** `/tools/codekeeper` is not present in the tracked tree (`git ls-tree -r HEAD -- tools` is empty; the on-disk directory is ignored debris with no manifest), so Dependabot's npm entry for it cannot resolve a manifest. The bug/feature issue templates still ask contributors for a "Codekeeper version or source commit" and a "codekeeper-review.yml" workflow for a product that is now `@coryparry/rivet`. `AGENTS.md` and the docs declare the Codekeeper trees retired.

**Fix direction:** drop the `/tools/codekeeper` Dependabot entry and CODEOWNERS/actionlint references, and update the issue templates to Rivet package/version terminology.

### 9. LOW — The `syntax` gate has drifted from the source inventory
**Path:** `packages/rivet/package.json` `scripts.syntax`.

**Impact:** 11 of 47 tracked first-party non-test `.mjs` files have no `node --check` line. The 6 `src/` modules are `model-endpoint.mjs`, `installation-trust.mjs`, `gh-aw/endpoint-trust.mjs`, `gh-aw/usage-cache.mjs` (new in this branch), `guided-environment.mjs`, `model-configuration-upgrade.mjs`; the other 5 are `scripts/check-custom-endpoint-lock.mjs`, `scripts/prepare-workflow-lint.mjs`, `scripts/refresh-review-authority.mjs`, `assets/upgrades/v0.1.12/publish-repair-index.mjs`, `assets/upgrades/v0.1.13/prepare-review-context-index.mjs`. The test run imports the `src/` modules, so a syntax error there surfaces later; the frozen upgrade scripts are never imported by tests, and the gate itself covers only 36/47 files. An independent omission pass reproduced the same list.

**Fix direction:** generate the check list from the module inventory, or add the missing files.

### 10. LOW — Setup-PR and install failure paths leave partial state
**Paths:** `packages/rivet/src/setup-pr.mjs:218-256`, `packages/rivet/src/install.mjs:92-110`.

**Impact:** the setup branch is pushed *before* `gh pr create`; if PR creation fails, the local and remote branch remain and the next run refuses at `setup-pr.mjs:184-186` until they are deleted manually. `applyInstallation` writes files sequentially with no rollback, so a mid-run I/O failure leaves a partially upgraded tree. Both are recovery gaps, not data-loss bugs.

**Fix direction:** create the PR first or clean up the pushed branch on failure; make the write phase transactional or drive from the validated plan with resumable status.

### 11. LOW — Review evaluator slices the original string with a lowercased offset
**Path:** `packages/rivet/evals/review-safe-outputs.mjs:110-120`.

**Impact:** `includesEvidence` computes `offset` in `value.toLowerCase()` and then slices the original `value`. For case mappings that change length (e.g. Turkish `İ`, ligatures), the slice is misaligned and a term ending in `:` may be judged empty. This is a grading-tool correctness issue only, with ASCII/emoji inputs unaffected.

**Fix direction:** search case-insensitively without changing length (e.g. index into a case-preserving scan) before slicing.

### 12. LOW / observation — Authority-receipt output is written but never consumed
**Path:** `packages/rivet/assets/review/.github/rivet/actions/authority-receipt/index.mjs:53-57`; `review-extension.md:12` exposes only `snapshot`.

The `receipt` output (workflow-ref and workflow-sha binding) appears nowhere else in the compiled review lock. If the intent was to bind the review to the trusted base workflow, no consumer enforces it; otherwise it is inert metadata and could be removed or documented.

### 13. LOW (process) — Issue-triage and maintenance authority constants have no regeneration path
Only `RIVET_REVIEW_*` digests are regenerated by `packages/rivet/scripts/refresh-review-authority.mjs`; `RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE` and the maintenance constants are maintained by hand and merely asserted by tests. This is the condition that lets a masking bug like finding 5 survive a compiler/engine bump unnoticed. Add a `--write` generator for every authority constant.

### 14. LOW — The `authority-receipt` fixture copy is not guarded against drift
**Path:** `test/fixtures/review/.github/rivet/actions/authority-receipt/{action.yml,index.mjs}` vs `assets/review/.github/rivet/actions/authority-receipt/{action.yml,index.mjs}`.

**Impact:** the review fixture directory mirrors the shipped review assets. Three of the four mirrored pairs are asserted equal by tests (`review-contract.test.mjs:24-56` for `review-extension.md` and `pr-reviewer.md`; `review-context-action.test.mjs:121-147` for `prepare-review-context`). `authority-receipt-action.test.mjs` tests the *asset* action but never compares it to the fixture copy, so that one copy can silently diverge while tests stay green. The fixture copy is byte-identical today.

**Fix direction:** add the same asset-vs-fixture equality assertion for `authority-receipt` (or delete the copy and reference the asset).

---

## Material unresolved risks and evidence gaps

- **Pinned-compiler reproduction did not run.** `npm --prefix packages/rivet run review-lock:check` failed with `EPERM: chmod '~/.cache/rivet/gh-aw/0.86.2/darwin-arm64/gh-aw'` because the cached binary is outside the workspace sandbox; the one-shot escalation to `danger-full-access` was rejected, so this is final. No compiled-workflow reproduction, actionlint run, or four-engine regeneration was performed. The Codex enabled/disabled/max-3 authority digests **were** independently recomputed from the checked-in compiled fixtures and match the updated constants; the Claude/Copilot/Gemini review digests and the issue-triage/maintenance digests remain unreproduced offline.
- **Live boundaries unverified:** GitHub App authorization, provider authentication, npm publication, and live adopter workflow execution were not exercised (no credentials/network boundary authorized).
- **Evals:** `evals/review-safe-outputs.mjs` was read fully; `evals/audit-safe-outputs.mjs` was reviewed at its manifest-validation, credential-detection, and scoring boundaries but not every line.

## Coverage and exclusions

Included and traced: all `packages/rivet/src` modules and `workflows/*`; `assets/{review,issue,maintenance,repair}` actions and agent profiles; `assets/upgrades/*` historical baselines; `packages/rivet/scripts`; root `scripts`; `.github/workflows` and governance config; root docs and package metadata. Tests and fixtures were used as evidence, not read exhaustively.
Excluded with reason: `node_modules`, `.git`, `.worktrees` (duplicate checkout), `.local` (ignored local debris), `packages/codekeeper/` and `tools/codekeeper/` (retired Codekeeper trees; `git status --ignored` shows them ignored and containing no first-party files), `.codegraph/`, `acceptance/`, `examples/` (ignored; contain only `.DS_Store`), `brand/` (not in the package `files` allow-list), `CHANGELOG.md` (generated history), `MANIFEST.sha256` (generated). `git ls-files --others --exclude-standard` reported no untracked first-party file before this report was added. Both lockfiles declare the exact `package.json` versions.

## Omission pass

A fresh reviewer was given the coverage manifest, exclusions, and unresolved edges but **not** the primary findings, and asked only for missed paths, contracts, companions, and unjustified stopping boundaries. Result: six leads were returned; each was checked against the snapshot.

- Syntax gate drift (lead 1): **confirmed and folded into finding 9** (11 files, not 6).
- Unnamed release/supply-chain files (lead 2): **checked, no defect** — both lockfiles declare the exact `package.json` versions, and `release-contract.test.mjs` binds the release-please manifest to the package version.
- Shipped evaluator bins (lead 3): **coverage boundary noted** — `evals/review-safe-outputs.mjs` was read fully and `evals/audit-safe-outputs.mjs` at its validation/scoring boundaries; neither is proven end-to-end.
- Unnamed on-disk retired trees (lead 4): **verified empty** — `packages/codekeeper`, `tools/codekeeper`, `acceptance`, `examples`, `.codegraph` are ignored and hold no first-party files; added to the exclusion list.
- Unreproduced fixture/compiler integrity (lead 5): **already reported** as the primary evidence gap.
- Mirrored fixture copy contract (lead 6): **partially confirmed** — the extension, profile, and `prepare-review-context` copies are test-guarded, but the `authority-receipt` copy is not; added as finding 14.

The omission pass did not review `docs/**` content, `assets/upgrades` internals, or `MANIFEST.sha256` semantics; those are called out in coverage.

## Disposition

**Partial at complete coverage** for the compiler-boundary lane: the pinned compiler could not be executed, so compiled-workflow regeneration and the non-Codex authority constants are not independently proven. The validated defects above are all reproducible at the reviewed snapshot. No finding is attributed to the branch's changes unless stated; findings 1–6 are reachable pre-existing behaviors, while the branch's own changes (usage-cache policy, review-context failure status, client-id rendering) were checked and the Codex trust digests reconciled.

---

## Resolution status — re-verified at d2d8e4ad (2026-09-11)

Between the reviewed snapshot (`2725588`) and the current HEAD (`d2d8e4ad`), commit `8de759fc` ("fix(rivet): enforce review and installer trust boundaries") plus a manifest refresh changed 60 files. I re-ran every reproduction and check against the new HEAD rather than accepting the commit message.

| # | Finding | Status | Independent verification on `d2d8e4ad` |
| --- | --- | --- | --- |
| 1 | Issue triage cannot be disabled | **Fixed** | `issues.triage: disabled` now plans deletion of all five triage files and removes them; reproduced OK. |
| 2 | Review policy cannot be changed | **Fixed** | `maximumFindings → 3` and `inlineFindings → false` now upgrade successfully; policy variants are first-class authority inventories. |
| 3 | Repair ignores configured engine | **Fixed** | `repair.mjs` now uses `validateRivetConfig(configuration).models.review` unconditionally; a claude config renders `engine: claude`. |
| 4 | No repair compiled-authority trust | **Fixed** | `assessRepairTrust` is wired into `installation-trust.mjs`; `repair-authority-trust.test.mjs` added. |
| 5 | Issue-triage digest masking | **Fixed** | Handler-env-only `create_issue` now yields "issue triage safe outputs differ from the approved handler set and settings". |
| 6 | Changed `.lock.yml` unreviewable | **Fixed** | `hasCompletePatch` no longer special-cases locks (missing patch fails closed) and the prompt was tightened to match. |
| 7 | PR CI does not reproduce compiler output | **Fixed** | `rivet-checks.yml` now runs `review-lock:check` and `refresh-review-authority.mjs`. |
| 8 | Stale Codekeeper config/templates | **Fixed** | Dependabot, issue templates, CODEOWNERS, and actionlint references cleaned. |
| 9 | `syntax` gate drift | **Fixed** | `scripts/syntax-inventory.mjs` walks the tree and `node --check`s every non-test `.mjs`; `syntax-inventory.test.mjs` added. |
| 10 | Setup-PR / install partial state | **Fixed** | New `installation-apply.mjs` performs captured rollback; `setup-pr.mjs` reworked with recovery evidence. |
| 11 | Evaluator case-offset slicing | **Fixed** | `includesEvidence` now slices the same lowercased string it searched. |
| 12 | Dead `authority-receipt` output | **Not resolved** | Still no consumer of `steps.rivet-authority.outputs.receipt` anywhere in `src`, `assets`, or tests. Remains a low observation (either wire it to an anti-fork check or document it as inert metadata). |
| 13 | No regeneration path for all inventories | **Fixed** | New `src/gh-aw/authority-inventory.mjs`; `refresh-review-authority.mjs` now verifies review, issue triage, maintenance, and repair inventories. |
| 14 | Unguarded `authority-receipt` fixture copy | **Fixed** | `authority-receipt-action.test.mjs` now asserts asset equals fixture for both files. |

**Verification run at `d2d8e4ad`:** package suite 364 tests / 0 fail; root `architecture:check` (21), `governance:check` (6), `lint`, `format:check` all pass; with a writable `RIVET_CACHE_HOME`, `npm --prefix packages/rivet run review-lock:check` passes ("Rivet workflow locks are current") and `node scripts/refresh-review-authority.mjs` passes for all four authority types. The compiler-reproduction evidence gap from the original report is therefore **closed**.

**Current working-tree blocker (not a code defect):** the checkout is dirty with untracked files — `CODE_REVIEW.md` and `CODE_REVIEW 2.md`, plus `packages/rivet/scripts/refresh-review-authority 2.mjs` and `refresh-review-authority 3.mjs`. Because they are not in `MANIFEST.sha256`, `bash scripts/release-source.sh --verify-worktree` fails ("MANIFEST.sha256 paths do not exactly cover the release inventory"), so the root `npm run check` cannot pass from this worktree. The stray `refresh-review-authority 2/3.mjs` and `CODE_REVIEW 2.md` were not created by me and should be removed before any release; the committed HEAD is unaffected.