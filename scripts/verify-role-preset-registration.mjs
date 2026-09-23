#!/usr/bin/env node
/**
 * Do the bundle's DECLARED role presets actually reach the composed tree?
 *
 * ## The question this answers
 *
 * `orchestra_draft` resolves every role through `ctx.get("agentPresets").resolve(id)`.
 * That registry only knows presets that a `@deepseek-ai/dsh-agent-preset` row declared
 * into the composed entry list — nothing else can put one there. So "the 12 role
 * presets are usable" reduces to a question about the COMPOSED tree, and the composed
 * tree is produced by the host's own patch engine, not by a second YAML reader here.
 *
 * The failure this guards has been observed twice in this repository:
 *   1. `- include: ./presets/....patch.yml` written as a PATCH. `include` is not a patch
 *      key at all — `applyEntryPatches` destructures `{ id, insert, name, ...overrides }`
 *      — so the row matches nothing, is skipped with a warning, and the tree stays empty
 *      while the file on disk looks right. Reading the YAML proves nothing here.
 *   2. A patch file listed in the prose but never declared in `dsh.bundle.patch`, so the
 *      boot never loads it (the shipped `@deepseek-ai/dsh-web-app` bundle declares its
 *      four preset files in that list, one entry per file).
 *
 * Both are invisible to a YAML read and both are visible in the composed result. Hence:
 * compose the same layers the boot composes, then assert on the RESULT.
 *
 * ## Modes
 *
 *   --profile <name>     compose a real profile (`~/.dsh/profiles/<name>`) through the
 *                        host's `loadProfileDirectory` + `composeEntries`.
 *   --bundle <dir>       compose a SYNTHETIC profile whose only bundle is the package at
 *                        <dir>. Used for the packed artifact: point it at the directory
 *                        `npm pack`'s tgz was unpacked into, so the assertion is about the
 *                        artifact rather than about this working tree.
 *
 * ## Assertions (all against the composed result)
 *
 *   - exactly one row per catalog role preset, entry id `preset-<id>`, `config.id` = `<id>`,
 *     module `@deepseek-ai/dsh-agent-preset`;
 *   - every such row carries a non-empty `config.plugins` list (a declaration with no
 *     plugin list cannot compose a session);
 *   - no patch was skipped (the compose warning sink is part of the verdict — this is the
 *     channel through which a wrong patch shape announces itself, and it must never be
 *     satisfied by "0 rows, 0 warnings" being read as success).
 *
 * The expected id set comes from the built catalog (`lib/orchestra-role-presets.js`), so a
 * dropped row, a renamed row and a duplicated row all fail; a hand-maintained expected count
 * would drift. `npm run build` before judging a script that reads `lib/`.
 *
 * Exit codes: 0 = every assertion held; 1 = an assertion failed; 2 = usage / missing precondition.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PRESET_MODULE = "@deepseek-ai/dsh-agent-preset";
const BIN_NAME = "dsh";
const ENTRY_PREFIX = "preset-";

function usage(message) {
  process.stderr.write(`verify-role-preset-registration: ${message}\n`);
  process.stderr.write(
    "usage: node scripts/verify-role-preset-registration.mjs [--profile <name>] [--bundle <package-dir>]\n" +
      "       [--dsh <path-to-dsh-install>] [--home <dsh-home>]\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { profile: undefined, bundle: undefined, dsh: undefined, home: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--profile") options.profile = argv[(index += 1)];
    else if (token === "--bundle") options.bundle = argv[(index += 1)];
    else if (token === "--dsh") options.dsh = argv[(index += 1)];
    else if (token === "--home") options.home = argv[(index += 1)];
    else usage(`unrecognised argument ${token}`);
  }
  if (options.profile === undefined && options.bundle === undefined) usage("pass --profile <name> or --bundle <package-dir>");
  if (options.profile !== undefined && options.bundle !== undefined) usage("--profile and --bundle are mutually exclusive");
  return options;
}

/**
 * The rows that make the role presets resolvable, as a pure function of the composed list.
 * Exported so a test can exercise the failure branches without a profile on disk.
 */
export function rolePresetRows(composed) {
  return composed.filter(
    (entry) =>
      entry?.name === PRESET_MODULE &&
      typeof entry?.id === "string" &&
      entry.id.startsWith(`${ENTRY_PREFIX}orchestra-`),
  );
}

/**
 * The assertion itself: one message per violation, empty array means the roster is sound.
 *
 * @param composed - the entry list `composeEntries` produced.
 * @param expectedIds - catalog preset ids (`orchestra-*`) that must each have exactly one row.
 * @param warnings - what the host's patch engine reported while composing.
 */
export function registrationFailures(composed, expectedIds, warnings = []) {
  const failures = [];
  const rows = rolePresetRows(composed);
  const byId = new Map();
  for (const row of rows) {
    const id = row?.config?.id;
    if (typeof id !== "string" || id === "") {
      failures.push(`row ${JSON.stringify(row?.id)} declares no config.id`);
      continue;
    }
    if (byId.has(id)) failures.push(`preset ${id} is declared by more than one row`);
    byId.set(id, row);
  }
  const missing = expectedIds.filter((id) => !byId.has(id));
  const extra = [...byId.keys()].filter((id) => !expectedIds.includes(id));
  if (missing.length > 0) {
    failures.push(
      `composed tree is missing ${missing.length} of ${expectedIds.length} role presets: ${missing.join(", ")} ` +
        `(rows found: ${rows.length}; a patch that matches nothing is skipped with a warning, so check the bundle's declared patch list)`,
    );
  }
  if (extra.length > 0) {
    failures.push(`composed tree declares ${extra.length} role preset(s) no catalog role owns: ${extra.join(", ")}`);
  }
  for (const id of expectedIds) {
    const row = byId.get(id);
    if (row === undefined) continue;
    if (row.id !== `${ENTRY_PREFIX}${id}`) {
      failures.push(`preset ${id} is declared by row id ${JSON.stringify(row.id)}; expected ${JSON.stringify(`${ENTRY_PREFIX}${id}`)}`);
    }
    if (!Array.isArray(row.config?.plugins) || row.config.plugins.length === 0) {
      failures.push(`preset ${id} declares an empty config.plugins list; it could not compose a session`);
    }
  }
  const skipped = warnings.filter((message) => /not found|id is required|name mismatch/i.test(message));
  if (skipped.length > 0) failures.push(`the patch engine skipped patches while composing: ${skipped.join(" | ")}`);
  return failures;
}

function resolveDshInstall(explicit) {
  if (explicit !== undefined) return explicit;
  if (typeof process.env.DSH_INSTALL === "string" && process.env.DSH_INSTALL !== "") return process.env.DSH_INSTALL;
  const candidates = [];
  try {
    candidates.push(createRequire(import.meta.url).resolve("@deepseek-ai/dsh/package.json"));
  } catch {
    // not resolvable from this repo; fall through to the global install location
  }
  candidates.push(join(process.execPath, "..", "..", "lib", "node_modules", "@deepseek-ai", "dsh", "package.json"));
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(candidate)) return candidate.replace(/\/package\.json$/, "");
  }
  return undefined;
}

/** A throwaway profile whose single bundle resolves to `bundleDir`. */
function syntheticProfile(bundleDir) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-preset-compose-"));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(bundleDir, join(root, "node_modules", "orchestra-dsh"), "dir");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      { name: "dsh-profile-preset-compose-probe", private: true, dsh: { profile: { bundles: ["orchestra-dsh"] } } },
      null,
      2,
    ),
  );
  return root;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dshInstall = resolveDshInstall(options.dsh);
  if (dshInstall === undefined) usage("could not locate the host DSH install; pass --dsh <path-to-dsh/package.json dir>");
  const appBootEntry = join(dshInstall, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js");
  if (!existsSync(appBootEntry)) usage(`host dsh-app-boot not found at ${appBootEntry}`);
  const appBoot = await import(appBootEntry);
  const { composeEntries, loadProfileDirectory, loadOptionalPatches } = appBoot;
  for (const [name, value] of Object.entries({ composeEntries, loadProfileDirectory, loadOptionalPatches })) {
    if (typeof value !== "function") usage(`host dsh-app-boot does not export ${name}`);
  }

  const catalog = await import(new URL("../lib/orchestra-role-presets.js", import.meta.url));
  const expectedIds = catalog.ALL_BUILTIN_ROLE_PRESETS.map((spec) => spec.id);

  const installAnchor = join(dshInstall, "package.json");
  let profileDir;
  let temporary;
  if (options.bundle !== undefined) {
    const bundleDir = resolve(options.bundle);
    if (!existsSync(join(bundleDir, "package.json"))) usage(`--bundle ${bundleDir} has no package.json`);
    temporary = syntheticProfile(bundleDir);
    profileDir = temporary;
  } else {
    const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
    profileDir = join(home, "profiles", options.profile);
    if (!existsSync(profileDir)) usage(`profile directory not found: ${profileDir}`);
  }

  const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const profile = loadProfileDirectory(BIN_NAME, profileDir, installAnchor, { userLayer: false });
  const profilePatches =
    Array.isArray(profile.patches) && profile.patches.length > 0
      ? profile.patches
      : (loadOptionalPatches(BIN_NAME, join(profileDir, "cordis.patch.yml")) ?? []);
  const homePatches = loadOptionalPatches(BIN_NAME, join(home, "cordis.patch.yml")) ?? [];

  const warnings = [];
  const layers = [...profile.layers.flatMap((layer) => layer.patches), ...profilePatches, ...homePatches];
  const composed = composeEntries(layers, (message) => warnings.push(message));

  const layersReport = profile.layers.map((layer) => `${layer.packageName}(${layer.patchPaths.length} file(s))`).join(" ");
  process.stdout.write(`# profile=${profile.name} bundle_layers=${layersReport}\n`);
  for (const warning of warnings) process.stdout.write(`# patch-warning ${warning}\n`);

  const rows = rolePresetRows(composed);
  for (const row of rows) {
    const plugins = Array.isArray(row.config?.plugins) ? row.config.plugins.length : "n/a";
    process.stdout.write(`ROLE_PRESET_ROW row=${row.id} config_id=${row.config?.id ?? "(none)"} plugins=${plugins}\n`);
  }

  const failures = registrationFailures(composed, expectedIds, warnings);
  for (const failure of failures) process.stdout.write(`ROLE_PRESET_FAIL ${failure}\n`);
  process.stdout.write(
    `# role_preset_rows=${rows.length} expected=${expectedIds.length} composed_entries=${composed.length} warnings=${warnings.length}\n`,
  );
  if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
  process.exit(failures.length === 0 ? 0 : 1);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
