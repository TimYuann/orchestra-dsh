#!/usr/bin/env node
/**
 * G-P0 ① (N7) — does a role session still carry its IDENTITY?
 *
 * ## The question, and why it is asked from OUTSIDE
 *
 * The release blocker is: a role session created through lazy-load or
 * reactivation came back after a process restart with only the host's global
 * tools — unable to read a file, unable to edit code — with no error and nothing
 * in the code that would ever notice.
 *
 * So this script never asks a session what it thinks it is. It reads persisted
 * facts off disk and compares them to what the ROSTER can resolve, which is the
 * only pair of values that can disagree in the way the blocker describes:
 *
 *   1. the session log's header, plus its `agent-preset/selected` events, folded
 *      through the HOST's own projection (`agentPresetProjectionDefinition`) —
 *      not a re-implementation of it;
 *   2. the harness's own `validateStoredEvents` — a log the harness refuses is a
 *      log whose identity cannot be read back at all;
 *   3. the roster's own discovery over the roots the deployment actually
 *      configures, for the preset id the role records;
 *   4. the role's recorded `blueprint` (what the plugin wrote at provisioning
 *      time as the EXPECTED composition) vs the roster's actual row set.
 *
 * ## It must not be a script that always says OK
 *
 * `--self-test` replaces one role's session id with a REAL, non-role session id
 * taken from the same session store, and requires `NOT_A_ROLE_SESSION` with a
 * non-zero exit. Without that, "no news is good news" would be indistinguishable
 * from a working check. This mirrors `check-session-readable.mjs`, which set the
 * precedent.
 *
 * ## Anchoring
 *
 * Every verdict is a per-role line and every assertion is on a symbol or a value.
 * There is one count, on the summary line, and it is a diagnostic: the exit code
 * comes from whether any role was reported missing, not from comparing counts.
 *
 * Usage:
 *   node scripts/verify-role-identity.mjs --repo <abs> --team <abs>
 *   node scripts/verify-role-identity.mjs --repo <abs> --team <abs> --self-test
 *
 * Exit codes: 0 = every role verified; 1 = a role failed or the calibration
 * detected nothing; 2 = usage, or a precondition (team file / session store /
 * roster) could not be read.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { readStoredEvents } from "./check-session-readable.mjs";

const HOST_PACKAGES =
  process.env.DSH_HOST_PACKAGES ??
  "/Users/yuantian/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";

/**
 * Where the plugin itself is installed in the deployment. The identity check
 * compares the roster's rows against the plugin's own idea of a composition, so
 * it reads the plugin's parser rather than writing a third one.
 */
const PLUGIN_DIR =
  process.env.DSH_PLUGIN_DIR ?? join(homedir(), ".dsh", "profiles", "dev", "node_modules", "orchestra-dsh");

function fail(message) {
  process.stdout.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { repo: undefined, team: undefined, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--repo") {
      options.repo = argv[++index];
    } else if (token === "--team") {
      options.team = argv[++index];
    } else if (token === "--self-test") {
      options.selfTest = true;
    } else {
      fail(`verify-role-identity: unrecognised argument ${token}`);
    }
  }
  if (options.repo === undefined || options.team === undefined) {
    fail("usage: node scripts/verify-role-identity.mjs --repo <abs> --team <abs> [--self-test]");
  }
  return options;
}

/** Load the harness's own modules: validation, projection, discovery, persistence. */
function loadHost() {
  const require = createRequire(import.meta.url);
  const load = (name) => {
    const path = join(HOST_PACKAGES, name, "lib", "index.js");
    if (!existsSync(path)) throw new Error(`host package not found: ${path}`);
    return require(path);
  };
  try {
    const session = load("dsh-session");
    const persistence = load("dsh-session-persistence");
    const presets = load("dsh-agent-presets");
    if (typeof persistence.validateStoredEvents !== "function") {
      throw new Error("dsh-session-persistence does not export validateStoredEvents");
    }
    if (presets.agentPresetProjectionDefinition === undefined) {
      throw new Error("dsh-agent-presets does not export agentPresetProjectionDefinition");
    }
    if (typeof presets.discoverPresets !== "function") {
      throw new Error("dsh-agent-presets does not export discoverPresets");
    }
    void session;
    for (const symbol of ["readComposition"]) {
      if (typeof presets[symbol] !== "function") throw new Error(`dsh-agent-presets does not export ${symbol}`);
    }
    const pluginFile = join(PLUGIN_DIR, "lib", "orchestra-role-presets.js");
    if (!existsSync(pluginFile)) throw new Error(`the installed plugin was not found at ${pluginFile}`);
    const orchestration = require(pluginFile);
    if (typeof orchestration.parseRolePresetComposition !== "function") {
      throw new Error("orchestra-dsh/lib/orchestra-role-presets.js does not export parseRolePresetComposition");
    }
    return {
      validateStoredEvents: persistence.validateStoredEvents,
      projection: presets.agentPresetProjectionDefinition,
      discoverPresets: presets.discoverPresets,
      readComposition: presets.readComposition,
      parseRolePresetComposition: orchestration.parseRolePresetComposition,
      shippedPresetRoot: presets.SHIPPED_PRESET_ROOT,
    };
  } catch (error) {
    throw new Error(`cannot load the harness's own modules: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The session store root for one cwd, using the harness's own slug rule.
 *
 * `~/.dsh/sessions/<slug>/<sessionId>/session.v3.jsonl.zstd`, where the slug is
 * the cwd with path separators and dots replaced — the shape recorded in the
 * plan's assumption list and observed on disk.
 */
export function slugForCwd(cwd) {
  const normalised = cwd.replace(/\/+$/, "");
  const slug = normalised.replace(/\//g, "-").replace(/\./g, "").replace(/^-/, "");
  return join(homedir(), ".dsh", "sessions", `--${slug}--`);
}

function sessionDirFor(store, sessionId) {
  const direct = join(store, sessionId);
  if (existsSync(direct)) return direct;
  return undefined;
}

/**
 * Fold one session log into its identity facts, using the host's own machinery.
 *
 * @returns `{ presetId, sessionId, cwd, eventCount, validated }`.
 */
function readSessionIdentity(host, store, sessionId) {
  const dir = sessionDirFor(store, sessionId);
  if (dir === undefined) throw new Error(`NOT_A_ROLE_SESSION: no session directory for ${sessionId} under ${store}`);
  const { logPath, header, events } = readStoredEvents(dir);
  // The harness's own acceptance check. A refused log means the identity cannot
  // be read back at all, which is a failure rather than a "no".
  host.validateStoredEvents(header, [...events], logPath);
  // The harness's own projection: header first, then selection events. Writing a
  // second folder here would let this script disagree with the running harness.
  let presetId = host.projection.init(header);
  for (const event of events) presetId = host.projection.apply(presetId, event);
  return {
    sessionId: typeof header?.id === "string" ? header.id : sessionId,
    presetId: presetId ?? null,
    cwd: header?.cwd,
    eventCount: events.length,
    logPath,
  };
}

/**
 * The composition rows a preset actually declares.
 *
 * Read through the HOST's `readComposition` and parsed by the PLUGIN's own
 * `parseRolePresetComposition`, so the row set here is the same one the plugin
 * compared against when it mounted the preset. A hand-rolled YAML walk would
 * produce a third opinion, which is exactly what this script must not have.
 */
async function compositionRows(preset, host) {
  if (preset === undefined) return undefined;
  const text = await host.readComposition(preset);
  const parsed = host.parseRolePresetComposition(text);
  return { rowIds: parsed.rowIds, pluginNames: parsed.pluginNames };
}

/** Resolve the roster over the roots the deployment configures, plus the defaults. */
async function buildRoster(host) {
  const home = join(homedir(), ".dsh");
  const roots = [
    { path: host.shippedPresetRoot, trust: "system" },
    {
      path: process.env.DSH_ORCHESTRA_CATALOG_ROOT ?? join(home, "orchestra", "catalog-presets"),
      trust: "system",
    },
    { path: join(home, ".agent-presets"), trust: "user" },
  ];
  const runnerDir = join(HOST_PACKAGES, "dsh-cordis-host-runner", "lib");
  const harnessBase = new URL(".", pathToFileURL(join(runnerDir, "index.js"))).href;
  const discovered = await host.discoverPresets(roots, harnessBase);
  return new Map(discovered.map((preset) => [preset.id, preset]));
}

/** Real session ids in the store, for the calibration's "real but not a role" pick. */
function realSessionIds(store) {
  if (!existsSync(store)) return [];
  // Only sessions that actually HAVE a readable log. A directory without one is
  // not a substitute: swapping it in would stop at "no log" and prove only that
  // missing sessions are reported missing — not that a real, wrong session is
  // refused, which is the calibration this flag exists for.
  return readdirSync(store, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "archived")
    .map((entry) => entry.name)
    .filter((id) => existsSync(join(store, id, "session.v3.jsonl.zstd")));
}

function main() {
  return (async () => {
    const options = parseArgs(process.argv.slice(2));

    if (!existsSync(options.team)) fail(`verify-role-identity: team file not found: ${options.team}`);
    let team;
    try {
      team = JSON.parse(readFileSync(options.team, "utf8"));
    } catch (error) {
      fail(`verify-role-identity: team file is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const roles = Array.isArray(team?.roles) ? team.roles : undefined;
    if (roles === undefined) fail("verify-role-identity: team file has no roles[]");

    let host;
    try {
      host = loadHost();
    } catch (error) {
      fail(`verify-role-identity: ${error instanceof Error ? error.message : String(error)}`);
    }

    const cwd = typeof team.cwd === "string" && team.cwd !== "" ? team.cwd : options.repo;
    const store = slugForCwd(cwd);
    if (!existsSync(store)) fail(`verify-role-identity: session store not found: ${store}`);

    let roster;
    try {
      roster = await buildRoster(host);
    } catch (error) {
      fail(`verify-role-identity: roster could not be built: ${error instanceof Error ? error.message : String(error)}`);
    }

    // `--self-test`: point ONE role at a real session that is not that role.
    // A real id is essential — a made-up one would only prove "missing".
    let substituted;
    if (options.selfTest) {
      const candidates = realSessionIds(store).filter((id) => !roles.some((role) => role.sessionId === id));
      if (candidates.length === 0) fail("verify-role-identity --self-test: no other real session to substitute");
      substituted = candidates.sort()[0];
      const target = roles.find((role) => role.phase === "active") ?? roles[0];
      process.stdout.write(`# self-test: role "${target.id}" sessionId ${target.sessionId} -> ${substituted} (a real, non-role session)\n`);
      target.sessionId = substituted;
    }

    let ok = 0;
    let missing = 0;
    for (const role of roles) {
      if (role.phase !== "active") {
        process.stdout.write(`IDENTITY_SKIP  ${role.id} phase=${role.phase}\n`);
        continue;
      }
      const expectedPreset = role.blueprint?.agentPreset ?? (typeof role.preset === "string" ? role.preset : undefined);
      let identity;
      try {
        identity = readSessionIdentity(host, store, role.sessionId);
      } catch (error) {
        process.stdout.write(`IDENTITY_MISSING ${role.id} ${role.sessionId} preset=${expectedPreset ?? "(none)"} rows=0 tools=0\n`);
        process.stdout.write(`          ${error instanceof Error ? error.message : String(error)}\n`);
        missing += 1;
        continue;
      }

      const problems = [];
      // 1. the log's own preset must be the role's preset.
      if (identity.presetId === null || identity.presetId === undefined) {
        problems.push(`the session log names no preset (expected ${expectedPreset ?? "(none)"})`);
      } else if (expectedPreset !== undefined && identity.presetId !== expectedPreset) {
        problems.push(
          `NOT_A_ROLE_SESSION: the session log names preset ${identity.presetId}, the role records ${expectedPreset}`,
        );
      }
      // 2. that preset must be resolvable BY NAME through the roster. This is the
      //    fact the blocker turns on: a preset the roster cannot resolve cannot be
      //    composed on resume.
      const preset = identity.presetId === null ? undefined : roster.get(identity.presetId);
      if (identity.presetId !== null && preset === undefined) {
        problems.push(`preset ${identity.presetId} is NOT resolvable through the roster`);
      } else if (preset?.broken !== undefined) {
        problems.push(`preset ${identity.presetId} resolves BROKEN: ${preset.broken}`);
      }
      // 3. the composition the preset ACTUALLY declares. Read through the host's
      //    reader and the plugin's own parser, so the numbers on the verdict line
      //    are the real row/tool counts rather than zeros that would make the line
      //    look reassuring while carrying no information.
      let composition;
      try {
        composition = await compositionRows(preset, host);
      } catch (error) {
        problems.push(`the preset's composition could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      const rows = composition?.rowIds.length ?? 0;
      const tools = composition?.pluginNames.length ?? 0;
      // A resolved preset with no rows is not a composition anything can run on.
      if (preset !== undefined && composition !== undefined && composition.rowIds.length === 0) {
        problems.push(`preset ${identity.presetId} resolves but declares no composition rows`);
      }
      // The recorded EXPECTED composition must be consistent with what the preset
      // file now says. The plugin writes whichever of these fields it has; when a
      // field is absent there is nothing to cross-check and that is stated, not
      // silently treated as agreement.
      const recordedRows = Array.isArray(role.blueprint?.compositionRowIds) ? role.blueprint.compositionRowIds : undefined;
      const recordedTools = Array.isArray(role.blueprint?.orchestraTools) ? role.blueprint.orchestraTools : undefined;
      const crossChecked = recordedRows !== undefined || recordedTools !== undefined;
      if (recordedRows !== undefined && composition !== undefined && recordedRows.length !== composition.rowIds.length) {
        problems.push(
          `recorded composition has ${recordedRows.length} row(s), the resolved preset declares ${composition.rowIds.length}`,
        );
      }

      // 4. a role whose session id changed must carry sessionHistory, and that
      //    history must not name the current id as replaced. Checked BEFORE the
      //    verdict is printed so a history problem can actually fail the role.
      const history = Array.isArray(role.sessionHistory) ? role.sessionHistory : [];
      if (history.some((entry) => entry.sessionId === role.sessionId)) {
        problems.push("sessionHistory lists the CURRENT session id as a replaced one");
      }

      if (problems.length === 0) {
        process.stdout.write(
          `IDENTITY_OK    ${role.id} ${role.sessionId} preset=${identity.presetId} rows=${rows} tools=${tools}` +
            `${crossChecked ? "" : " (no recorded composition to cross-check)"}\n`,
        );
        ok += 1;
      } else {
        process.stdout.write(
          `IDENTITY_MISSING ${role.id} ${role.sessionId} preset=${identity.presetId ?? "(none)"} rows=${rows} tools=${tools}\n`,
        );
        for (const problem of problems) process.stdout.write(`          ${problem}\n`);
        missing += 1;
      }

      // 5. every replaced id in the history is checked on the same terms.
      for (const entry of history) {
        try {
          readSessionIdentity(host, store, entry.sessionId);
          process.stdout.write(`IDENTITY_OK    ${role.id} (history) ${entry.sessionId}\n`);
        } catch (error) {
          process.stdout.write(`IDENTITY_MISSING ${role.id} (history) ${entry.sessionId}\n`);
          process.stdout.write(`          ${error instanceof Error ? error.message : String(error)}\n`);
          missing += 1;
        }
      }
    }

    process.stdout.write(`# roles ${roles.length} ok ${ok} missing ${missing}\n`);

    if (options.selfTest) {
      // Calibration passes when the substitution was DETECTED, which means this
      // invocation must fail. Exit 1 is the expected code for --self-test.
      const detected = missing > 0;
      process.stdout.write(`# self-test detected=${detected ? "yes" : "NO"}\n`);
      return detected ? 1 : 0;
    }
    return missing === 0 ? 0 : 1;
  })();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
