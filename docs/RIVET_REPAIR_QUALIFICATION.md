# Rivet repair qualification (historical gate record)

This document records the historical qualification gate for Rivet repair. Rivet
now ships an explicit owner-authorized repair installation, but the remaining
lineage and live-authority work below is still pending; this record does not
claim that those gates are complete.

## Candidate controls

The repair source requires:

- the exact `/rivet-repair` command on a pull request comment;
- an actor with GitHub's exact `admin` repository role;
- a same-repository triggering pull request;
- one push back to that triggering pull request;
- no fallback pull request after a non-fast-forward failure;
- blocked protected files;
- at most 25 changed files and a 1 MiB patch; and
- a separate Rivet App token for the safe-output path.

The agent job retains read-only GitHub permissions and does not receive `RIVET_APP_PRIVATE_KEY`. The pinned compiler places the App credential only in deterministic activation and safe-output jobs. The candidate exposes neither pull-request creation nor merge output.

## Pinned compiler result

The checked-in source compiled cleanly with gh-aw `v0.86.2` in strict action
mode using the pinned actions commit. Inspection of the generated workflow
confirmed:

- the exact-command condition is preserved in activation;
- the only event is `issue_comment` filtered to pull requests;
- every checkout stays in the current repository;
- checkout credentials are not persisted in the agent job;
- all third-party actions and containers are immutable; and
- the Rivet App private key is absent from the agent job.

The generated lock file is deliberately not installed or checked in at this gate.

## Repair lineage

Rivet records repair progress as one immutable sequence:

1. review head and findings fingerprint;
2. authorization actor, comment, and still-live head;
3. successful command exit codes and the new repair commit; and
4. a fresh review of that exact repair commit.

The sequence rejects moved heads, failed commands, no-change repairs, reordered steps, forged base records, and altered validation receipts. A repair is complete only when the fresh review of the repair commit has no blocking result. Each new repair attempt starts a new lineage from the newly reviewed head.

This state machine validates receipts supplied by deterministic workflow steps. It does not treat an agent's claim that validation ran as proof.

## Remaining qualification hardening

The upstream primitive enforces same-repository targeting, protected paths, patch limits, and non-fast-forward failure. It does not by itself prove that the configured validation commands ran successfully, and prompt instructions are not a deterministic validation gate.

The historical candidate left these follow-up gates open. They are evidence and
hardening work for a future qualification update, not prerequisites for the
explicit repair installation:

1. wire a deterministic validation runner and the lineage state machine into publication;
2. persist the lineage through a Rivet-owned GitHub marker or check result;
3. verify live that the Rivet App was widened from Contents read to Contents write; and
4. re-run these checks for any installer or update PR that changes repair authority.

Until then, review remains the default operational workflow. Repair is an
explicit owner-authorized upgrade that requires the separate App authority and
owner command described in the installer documentation.
