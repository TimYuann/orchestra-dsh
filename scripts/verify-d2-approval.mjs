#!/usr/bin/env node
/**
 * G-P0 ③ (D2-a + D2-c) — does an approval question ever PARK a turn?
 *
 * ## The question, and why it is asked from the log
 *
 * The D2 blocker is a turn that never ends: a role hits the sandbox, is told
 * escalation is available, raises an approval prompt — and in an unattended run
 * nobody answers it. The host writes the whole story as facts, so this script
 * never asks a session what it thinks happened. It reads the persisted log and
 * checks the two invariants the host itself promises:
 *
 *  1. every `approval/asked` is paired with an `approval/decided` carrying the
 *     SAME request id, inside the SAME `turn/start` … `turn/end` interval
 *     (§4.8 D2-a step 3 / D2-c step 1);
 *  2. the turn that contained the ask actually CLOSED, and closed after the
 *     answer (§4.8 D2-a step 4).
 *
 * It also checks the pin itself: the session's effective `approval/policy` must
 * be the expected value (`never` for a governed role), because a session left on
 * the deployment default is exactly how the prompt gets raised in the first
 * place (§4.8 D2-a step 1).
 *
 * ## What it deliberately does NOT assert
 *
 * `outcome` is checked against the SET
 * `{allowed-once, rejected, cancelled, unavailable}`, never against a single
 * value. `never` does not imply `rejected`: the host checks `signal?.aborted`
 * BEFORE it checks the policy, so a pre-aborted request under `never` is
 * recorded as `cancelled`. Asserting `rejected` would fail a correct session.
 * Nor does anything here claim the model never TRIES to escalate — that is
 * `capability-boundaries.md` #1; what is checkable is "the request does not park
 * and the turn ends".
 *
 * ## It must not be a script that always says OK
 *
 * `--self-test` builds a synthetic log with a properly paired ask, proves the
 * baseline passes, then deletes one `decided` and requires the script to report
 * `dangling_approval` with a non-zero exit. A calibration that notices nothing
 * returns 2, not 0: "the check said OK" and "the check was never exercised" must
 * not look alike. It needs no fixture and no live instance, because it carries
 * its own input.
 *
 * ## Anchoring
 *
 * Every verdict is per session and every assertion is on an event field. The
 * summary line carries the two counts the gate reads (`hanging` and `dangling`)
 * and is a diagnostic: the exit code comes from whether any invariant broke.
 *
 * Usage:
 *   node scripts/verify-d2-approval.mjs --session <sessionDir> [--session <dir> ...]
 *   node scripts/verify-d2-approval.mjs --self-test
 *   node scripts/verify-d2-approval.mjs --session <dir> --expect-policy ask
 *
 * Exit codes: 0 = every session passed; 1 = a turn hangs, an ask is unpaired, an
 * outcome is outside the set, or the policy is not the expected one; 2 = usage,
 * or a session log could not be read, or the calibration detected nothing.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { readStoredEvents } from "./check-session-readable.mjs";

/** Every outcome the host can record. A value outside this set is a defect. */
const OUTCOMES = new Set(["allowed-once", "rejected", "cancelled", "unavailable"]);

/**
 * A scratch directory that is NOT under the DSH home.
 *
 * This environment points `TMPDIR` at `<dsh home>/tmp`, which would put the
 * synthetic calibration logs inside the state tree a verification round is
 * forbidden to write to. A temp file is not plugin state, but the distinction is
 * exactly the kind of thing that gets lost between rounds, so the base is chosen
 * explicitly rather than inherited.
 */
function scratchBase() {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const inherited = tmpdir();
  return inherited === home || inherited.startsWith(`${home}/`) ? "/tmp" : inherited;
}

function fail(message) {
  process.stdout.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { sessions: [], selfTest: false, expectPolicy: "never" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--session") {
      const value = argv[++index];
      if (value === undefined || value === "") fail("usage: --session needs a directory");
      options.sessions.push(value);
    } else if (token === "--self-test") {
      options.selfTest = true;
    } else if (token === "--expect-policy") {
      const value = argv[++index];
      if (value !== "ask" && value !== "never") fail(`usage: --expect-policy must be "ask" or "never", got ${String(value)}`);
      options.expectPolicy = value;
    } else {
      fail(`verify-d2-approval: unrecognised argument ${token}`);
    }
  }
  if (options.sessions.length === 0 && !options.selfTest) {
    fail("usage: node scripts/verify-d2-approval.mjs --session <sessionDir> [--session <dir> ...] | --self-test");
  }
  return options;
}

/**
 * Fold one session log into its approval facts.
 *
 * Turn intervals are tracked as a stack-free pair per turn number: the host
 * numbers turns monotonically and closes each one, so "the ask and its answer
 * sit inside the same interval" is checked by remembering, for each open turn,
 * the seq at which it started.
 *
 * @returns one verdict per session plus the two summary counts.
 */
function inspectSession(sessionDir, expectPolicy) {
  const { events } = readStoredEvents(sessionDir);
  const problems = [];
  const openTurns = new Map();
  let hanging = 0;
  let asked = 0;
  let dangling = 0;
  let policy;

  const note = (message) => problems.push(message);

  for (const event of events) {
    const type = event?.type;
    const data = event?.data ?? {};
    if (type === "approval/policy") {
      policy = typeof data.policy === "string" ? data.policy : undefined;
      continue;
    }
    if (type === "turn/start") {
      openTurns.set(data.turn, event.seq);
      continue;
    }
    if (type === "turn/end") {
      if (!openTurns.delete(data.turn)) note(`turn ${String(data.turn)} ended without ever starting`);
      continue;
    }
    if (type !== "approval/asked" && type !== "approval/decided") continue;

    // Which turn is this event inside? The most recent turn that opened at or
    // before this seq and has not closed yet.
    let turnOf;
    for (const [turn, startSeq] of openTurns) {
      if (startSeq <= event.seq && (turnOf === undefined || startSeq > openTurns.get(turnOf))) turnOf = turn;
    }
    if (turnOf === undefined) {
      note(`${type} at seq ${String(event.seq)} sits outside any open turn`);
      continue;
    }
    if (type === "approval/asked") {
      asked += 1;
      event.__turn = turnOf;
      continue;
    }
    event.__turn = turnOf;
  }

  // Turns that never closed are the D2 blocker in its purest form.
  for (const [turn, startSeq] of openTurns) {
    hanging += 1;
    note(`turn ${String(turn)} opened at seq ${String(startSeq)} and never closed`);
  }

  // Pairing, by request id, inside the same turn interval.
  const answers = new Map();
  for (const event of events) {
    if (event?.type !== "approval/decided") continue;
    const id = typeof event.data?.id === "string" ? event.data.id : "";
    answers.set(id, event);
  }
  for (const event of events) {
    if (event?.type !== "approval/asked") continue;
    const id = typeof event.data?.id === "string" ? event.data.id : "";
    const answer = answers.get(id);
    if (answer === undefined) {
      dangling += 1;
      note(
        `dangling_approval: ${id} for tool ${String(event.data?.toolName ?? "(unnamed)")} ` +
          `was asked at seq ${String(event.seq)} in turn ${String(event.__turn)} and never decided`,
      );
      continue;
    }
    if (answer.__turn !== event.__turn) {
      note(
        `dangling_approval: ${id} was asked in turn ${String(event.__turn)} but decided in turn ${String(answer.__turn)}`,
      );
      continue;
    }
    if (answer.seq < event.seq) {
      note(`dangling_approval: ${id} was decided at seq ${String(answer.seq)} before it was asked at ${String(event.seq)}`);
      continue;
    }
    const outcome = answer.data?.outcome;
    if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) {
      note(`dangling_approval: ${id} carries outcome ${JSON.stringify(outcome)}, which is not one of ${[...OUTCOMES].join(", ")}`);
    }
  }

  // D2-a step 1: the pin itself. A session with no override carries the
  // deployment default, which for `workspace-write` is `ask`.
  if (policy !== expectPolicy) {
    note(
      policy === undefined
        ? `approval policy is unset (the deployment default applies), expected "${expectPolicy}"`
        : `approval policy is "${policy}", expected "${expectPolicy}"`,
    );
  }

  return { sessionDir, problems, hanging, dangling, asked };
}

/** A minimal but well-formed session header, so the log the host would accept. */
function syntheticHeader(sessionId) {
  return { type: "session", version: 3, id: sessionId, cwd: "/tmp/verify-d2-approval", createdAt: 1 };
}

/** Write one synthetic log and return its session directory. */
async function writeSyntheticLog(root, sessionId, events) {
  const dir = join(root, sessionId);
  await mkdir(dir, { recursive: true });
  const jsonl = join(root, `${sessionId}.jsonl`);
  await writeFile(jsonl, [syntheticHeader(sessionId), ...events].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  execFileSync("zstd", ["-q", "-f", "-o", join(dir, "session.v3.jsonl.zstd"), jsonl]);
  return dir;
}

/**
 * The calibration: a paired log must pass, and the same log with one `decided`
 * removed must fail with `dangling_approval`.
 *
 * @returns the exit code the calibration itself deserves.
 */
async function selfTest() {
  const root = await mkdtemp(join(scratchBase(), "verify-d2-approval-"));
  try {
    const paired = [
      { type: "approval/policy", seq: 1, data: { policy: "never" } },
      { type: "turn/start", seq: 2, data: { turn: 1 } },
      { type: "step/start", seq: 3, data: { turn: 1, step: 1 } },
      { type: "tool/call", seq: 4, data: { turn: 1, step: 1, callId: "call-1", name: "bash", arguments: "{}" } },
      { type: "approval/asked", seq: 5, data: { id: "ask-calibration", toolName: "bash", callId: "call-1" } },
      { type: "approval/decided", seq: 6, data: { id: "ask-calibration", outcome: "rejected" } },
      { type: "tool/result", seq: 7, data: { turn: 1, step: 1, callId: "call-1", isError: true } },
      { type: "step/end", seq: 8, data: { turn: 1, step: 1 } },
      { type: "turn/end", seq: 9, data: { turn: 1, reason: { kind: "completed" } } },
    ];
    const clean = await writeSyntheticLog(root, "session-calibration-paired", paired);
    process.stdout.write(`# self-test: baseline log ${clean}\n`);
    const baseline = inspectSession(clean, "never");
    // The same line the main mode prints, so "a pinned, paired log is green" is
    // visible inside the calibration rather than asserted somewhere else.
    process.stdout.write(
      baseline.problems.length === 0
        ? `APPROVAL_OK    ${clean} hanging 0 dangling 0\n`
        : `APPROVAL_MISSING ${clean} hanging ${baseline.hanging} dangling ${baseline.dangling}\n`,
    );
    if (baseline.problems.length > 0) {
      for (const problem of baseline.problems) process.stdout.write(`          ${problem}\n`);
      fail("verify-d2-approval --self-test: the paired baseline log did not pass, so the calibration input is wrong");
    }

    // The injected defect: the answer is gone, the question is still there.
    const unpaired = paired.filter((event) => event.type !== "approval/decided");
    const broken = await writeSyntheticLog(root, "session-calibration-unpaired", unpaired);
    process.stdout.write(`# self-test: perturbed log ${broken} (one approval/decided removed)\n`);
    const perturbed = inspectSession(broken, "never");
    for (const problem of perturbed.problems) process.stdout.write(`          ${problem}\n`);
    const detected = perturbed.problems.some((problem) => problem.startsWith("dangling_approval:"));
    process.stdout.write(`# self-test dangling=${detected ? "detected" : "NOT-DETECTED"}\n`);
    // Exit 1 is the expected code for --self-test: the calibration worked, and
    // here is what it caught. A calibration that detects NOTHING returns 2.
    return detected ? 1 : 2;
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
}

function main() {
  return (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.selfTest) return await selfTest();

    let hanging = 0;
    let dangling = 0;
    let problems = 0;
    let failed = 0;
    for (const sessionDir of options.sessions) {
      let verdict;
      try {
        verdict = inspectSession(sessionDir, options.expectPolicy);
      } catch (error) {
        fail(`verify-d2-approval: ${sessionDir}: ${error instanceof Error ? error.message : String(error)}`);
      }
      hanging += verdict.hanging;
      dangling += verdict.dangling;
      problems += verdict.problems.length;
      if (verdict.problems.length === 0) {
        process.stdout.write(`APPROVAL_OK    ${sessionDir} hanging 0 dangling 0\n`);
        continue;
      }
      failed += 1;
      process.stdout.write(`APPROVAL_MISSING ${sessionDir} hanging ${verdict.hanging} dangling ${verdict.dangling}\n`);
      for (const problem of verdict.problems) process.stdout.write(`          ${problem}\n`);
    }
    // `problems` is carried on the summary so a non-zero exit is always explained:
    // a bad `outcome` or an unexpected policy is a failure with `hanging 0
    // dangling 0`, and that must be readable rather than looking like a bug.
    process.stdout.write(
      `# sessions ${options.sessions.length} ok ${options.sessions.length - failed} missing ${failed}` +
        ` hanging ${hanging} dangling ${dangling} problems ${problems}\n`,
    );
    return hanging > 0 || dangling > 0 || failed > 0 ? 1 : 0;
  })();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
