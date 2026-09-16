#!/usr/bin/env node
/**
 * Does the harness actually accept this session's stored log?
 *
 * The P0 blocker was not "our records are in a surprising place" — it was that
 * DSH REFUSES an entire persisted log containing an event type it does not know
 * (`dsh-session-persistence` → `validateStoredEvents`), and an out-of-repo plugin
 * cannot mark its own events ignorable. So a session written by this plugin
 * became unopenable, including sessions the plugin did not own.
 *
 * This script asks the platform's own question — "would you accept this log?" —
 * instead of pattern-matching for our event names. It is the acceptance check for
 * `docs/adr/0002`.
 *
 * Usage:
 *   node scripts/check-session-readable.mjs <session-dir> [<session-dir> ...]
 *   node scripts/check-session-readable.mjs --self-test    # prove it detects a known-bad log
 *
 * Exit code 0 when every checked log is readable, 1 otherwise.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const HOST_PACKAGES = "/Users/yuantian/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";

function loadHost() {
  const sessionModule = process.env.DSH_SESSION_MODULE ?? `${HOST_PACKAGES}/dsh-session/lib/index.js`;
  const persistenceModule = process.env.DSH_PERSISTENCE_MODULE ?? `${HOST_PACKAGES}/dsh-session-persistence/lib/index.js`;
  let session;
  let persistence;
  try {
    session = require(sessionModule);
    persistence = require(persistenceModule);
  } catch (error) {
    throw new Error(
      `cannot load the harness's session modules (set DSH_SESSION_MODULE / DSH_PERSISTENCE_MODULE): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!(session?.KNOWN_SESSION_EVENT_TYPES instanceof Set) || typeof persistence?.validateStoredEvents !== "function") {
    throw new Error("the loaded session modules do not export KNOWN_SESSION_EVENT_TYPES / validateStoredEvents");
  }
  return { knownTypes: session.KNOWN_SESSION_EVENT_TYPES, validateStoredEvents: persistence.validateStoredEvents };
}

/**
 * Decode one stored log into its event envelopes.
 *
 * The log is a CONCATENATION of zstd frames — one per append batch — and Node's
 * `zstdDecompressSync` stops after the first frame, silently returning just the
 * header. That failure mode is dangerous here of all places: a truncated read
 * would report every session as clean. So the whole file is decoded through the
 * `zstd` binary, and a decode failure is an error rather than an empty event list.
 */
export function readStoredEvents(sessionDir) {
  const logPath = join(sessionDir, "session.v3.jsonl.zstd");
  if (!existsSync(logPath)) throw new Error(`no session.v3.jsonl.zstd under ${sessionDir}`);
  let text;
  try {
    text = execFileSync("zstd", ["-d", "-c", logPath], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8");
  } catch (error) {
    throw new Error(
      `could not decode ${logPath} (is the \`zstd\` binary installed?): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!text.includes("\n")) throw new Error(`${logPath} decoded to a single line; the log was probably truncated`);
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const records = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${logPath} line ${index + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  // Line 1 is the create header (`type: "session"`); every following line is one
  // event. The header carries a `type` too, so it cannot be told apart by shape.
  const header = records[0];
  const events = records.slice(1);
  return { logPath, header, events };
}

/**
 * The same rule `validateStoredEvents` applies, reported instead of thrown so a
 * caller gets the full list rather than the first offender.
 */
export function unknownEventTypes(events, knownTypes) {
  const unknown = [];
  for (const event of events) {
    if (knownTypes.has(event.type)) continue;
    if (event.ignorable === true) continue;
    unknown.push({ seq: event.seq, type: event.type });
  }
  return unknown;
}

export function checkSession(sessionDir, host) {
  const { logPath, header, events } = readStoredEvents(sessionDir);
  const sessionId = typeof header?.id === "string" ? header.id : "(unknown)";
  // The harness's OWN validation, on the harness's own terms: anything this
  // accepts is a log the harness will open, and anything it rejects is one it
  // will refuse — no rule of ours in between.
  try {
    host.validateStoredEvents(header, [...events], logPath);
    return { sessionDir, logPath, sessionId, eventCount: events.length, unknown: [], readable: true, error: undefined };
  } catch (error) {
    return {
      sessionDir,
      logPath,
      sessionId,
      eventCount: events.length,
      unknown: unknownEventTypes(events, host.knownTypes),
      readable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function report(result) {
  const verdict = result.readable ? "READABLE" : "REFUSED";
  console.log(`${verdict}  ${result.sessionId}`);
  console.log(`          ${result.logPath}`);
  console.log(`          ${result.eventCount} event(s)`);
  for (const entry of result.unknown) {
    console.log(`          seq ${entry.seq}: unknown event type "${entry.type}"`);
  }
  if (result.error !== undefined && result.unknown.length === 0) {
    console.log(`          ${result.error}`);
  }
}

function main(argv) {
  if (argv.includes("--self-test")) {
    // Calibrate: a log containing an event type the harness does not know MUST be
    // refused. Without this, a checker that always says READABLE would look fine.
    const host = loadHost();
    const planted = [{ seq: 1, type: "orchestra/blueprint" }, { seq: 2, type: "user/message" }];
    const found = unknownEventTypes(planted, host.knownTypes);
    const detected = found.length === 1 && found[0].type === "orchestra/blueprint";
    const clean = unknownEventTypes([{ seq: 1, type: "user/message" }, { seq: 2, type: "assistant/message" }], host.knownTypes);
    console.log(`known event types: ${host.knownTypes.size}`);
    console.log(`detects a planted orchestra/blueprint event: ${detected ? "yes" : "NO"}`);
    console.log(`reports a clean log as clean: ${clean.length === 0 ? "yes" : "NO"}`);
    return detected && clean.length === 0 ? 0 : 1;
  }

  const targets = argv.filter((value) => !value.startsWith("--"));
  if (targets.length === 0) {
    console.error("usage: node scripts/check-session-readable.mjs <session-dir> [...] | --self-test");
    return 2;
  }
  const host = loadHost();
  let failed = 0;
  for (const target of targets) {
    try {
      const result = checkSession(target, host);
      report(result);
      if (!result.readable) failed += 1;
    } catch (error) {
      console.log(`ERROR  ${target}`);
      console.log(`          ${error instanceof Error ? error.message : String(error)}`);
      failed += 1;
    }
  }
  console.log(failed === 0 ? "\nall checked logs are readable" : `\n${failed} log(s) would be refused`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
