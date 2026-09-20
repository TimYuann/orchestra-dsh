/**
 * G-P0 ⑤ — the roster really recognises the plugin's preset root.
 *
 * ## The question this answers
 *
 * After the §7 single-hop override, does the COMPOSED deployment actually carry
 * `agent-presets` with the plugin's private catalog root
 * (`~/.dsh/orchestra/catalog-presets`, `trust: system`) on top of the bundle's own
 * config? If it does not, every `presets.resolve(id)` for a catalog preset fails
 * and S3's whole point — presets reachable BY NAME through the roster, so a
 * session rebuilt after a restart still finds its identity — silently does not hold.
 *
 * It is deliberately NOT a re-reading of the YAML. Reading the file proves only
 * that the file says the right thing. The failure this guards is "the file is
 * right but the composed entry list is not", which is exactly what a wrong patch
 * shape produces: a two-hop insert yields TWO `agent-presets` rows and leaves the
 * original holding its old config (measured — plan §7.4 probe C). So the check
 * composes the same layers the boot composes and asserts on the RESULT.
 *
 * The layer assembly mirrors `dsh-app-boot`'s own `readProfilePatches`:
 *   bundle layers (in `dsh.profile.bundles` order) → the profile's own patch file
 *   → `$DSH_HOME/cordis.patch.yml` → overlays
 * and both halves are read through the host's own loader (`loadProfileDirectory`
 * and `loadOptionalPatches`), so there is no second YAML reader here to drift.
 *
 * ## Anchoring
 *
 * Assertions are on row identity and config VALUES, and on each directory's own
 * verdict. The trailing `# presets healthy=…` line is the plan's specified
 * summary and a diagnostic only; nothing compares a count to a count.
 *
 * ## Scope
 *
 * Defaults to the `dev` profile. `web` is neither defaulted nor swept in:
 * development touches dev only (U9 boundary). Pass `--profile web` explicitly if a
 * human decides to check it.
 *
 * Exit codes: 0 = every assertion held; 1 = an assertion failed; 2 = usage or a
 * missing precondition (host DSH install or profile not resolvable).
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const CATALOG_ROOT_SPEC = "~/.dsh/orchestra/catalog-presets";
const CATALOG_ROOT = join(homedir(), ".dsh", "orchestra", "catalog-presets");
const PROFILE_PATCH_FILENAME = "cordis.patch.yml";
const BIN_NAME = "dsh";

function usage(message) {
  process.stderr.write(`verify-role-presets-roster: ${message}\n`);
  process.stderr.write(
    "usage: node scripts/verify-role-presets-roster.mjs [--profile dev] [--dsh <path-to-dsh-install>] [--home <dsh-home>]\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { profile: "dev", dsh: undefined, home: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--profile") {
      options.profile = argv[index + 1];
      index += 1;
    } else if (token === "--dsh") {
      options.dsh = argv[index + 1];
      index += 1;
    } else if (token === "--home") {
      options.home = argv[index + 1];
      index += 1;
    } else {
      usage(`unrecognised argument ${token}`);
    }
  }
  if (typeof options.profile !== "string" || options.profile === "") usage("--profile needs a value");
  return options;
}

/**
 * The assertion itself, as a pure function over the COMPOSED rows.
 *
 * Exported so it can be exercised against synthetic entry lists — including the
 * two documented ways this row goes wrong (a two-hop insert producing two rows,
 * and a `config` override written without `default`, which a shallow per-key
 * replacement turns into a dropped value). Running the script alone only ever
 * proves the happy path; this is what makes the failure branch verifiable.
 *
 * @param composed - the entry list `composeEntries` produced.
 * @returns one message per violation; an empty array means the roster is sound.
 */
export function rosterFailures(composed) {
  const failures = [];
  const rows = composed.filter((entry) => entry?.id === "agent-presets");
  if (rows.length !== 1) {
    failures.push(
      `composed entry list has ${rows.length} rows with id "agent-presets"; exactly one is required ` +
        "(two rows means the patch was written as a two-hop insert, which overrides nothing — plan §7.4 probe C)",
    );
  }
  const row = rows[0];
  if (row === undefined) return failures;
  const config = row.config ?? {};
  if (config.default !== "standard") {
    failures.push(
      `composed agent-presets config.default is ${JSON.stringify(config.default)}; expected "standard" ` +
        "(a `config` override is a shallow per-key replacement, so writing it without `default` drops the bundle's value)",
    );
  }
  const roots = Array.isArray(config.roots) ? config.roots : [];
  const owning = roots.filter((root) => root?.path === CATALOG_ROOT_SPEC);
  if (owning.length !== 1) {
    failures.push(
      `composed agent-presets config.roots does not contain exactly one entry for ${JSON.stringify(CATALOG_ROOT_SPEC)} ` +
        `(found ${owning.length}); roots=${JSON.stringify(roots)}`,
    );
  } else if (owning[0].trust !== "system") {
    failures.push(`the catalog root trust is ${JSON.stringify(owning[0].trust)}; expected "system"`);
  }
  return failures;
}

/**
 * Locate the host's DSH install. The plugin deliberately does not depend on
 * `dsh-app-boot` — that is the app's own boot layer, not a plugin peer — so the
 * engine is borrowed from the host that will actually run this composition, which
 * is also the only copy whose verdict matters here.
 */
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dshInstall = resolveDshInstall(options.dsh);
  if (dshInstall === undefined) usage("could not locate the host DSH install; pass --dsh <path-to-dsh/package.json dir>");

  const appBootEntry = join(dshInstall, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js");
  if (!existsSync(appBootEntry)) usage(`host dsh-app-boot not found at ${appBootEntry}`);
  const appBoot = await import(appBootEntry);
  const { composeEntries, loadProfileDirectory, loadOptionalPatches } = appBoot;
  if (typeof composeEntries !== "function") usage("host dsh-app-boot does not export composeEntries");
  if (typeof loadProfileDirectory !== "function") usage("host dsh-app-boot does not export loadProfileDirectory");

  const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const profileDir = join(home, "profiles", options.profile);
  if (!existsSync(profileDir)) usage(`profile directory not found: ${profileDir}`);

  const installAnchor = join(dshInstall, "package.json");
  // `userLayer: false` keeps this read to the profile's OWN patch file; the home
  // layer is added below, in the same order the boot uses.
  const profile = loadProfileDirectory(BIN_NAME, profileDir, installAnchor, { userLayer: false });
  const profilePatches = Array.isArray(profile.patches) && profile.patches.length > 0
    ? profile.patches
    : (loadOptionalPatches(BIN_NAME, join(profileDir, PROFILE_PATCH_FILENAME)) ?? []);
  const homePatches = loadOptionalPatches(BIN_NAME, join(home, "cordis.patch.yml")) ?? [];

  const warnings = [];
  const layers = [
    ...profile.layers.flatMap((layer) => layer.patches),
    ...profilePatches,
    ...homePatches,
  ];
  const composed = composeEntries(layers, (message) => warnings.push(message));

  // --- assertions on the COMPOSED result ------------------------------------
  const failures = [...rosterFailures(composed)];
  const rows = composed.filter((entry) => entry?.id === "agent-presets");
  const config = rows[0]?.config ?? {};

  // --- per-preset directory health ------------------------------------------
  const directories = [];
  try {
    for (const entry of await readdir(CATALOG_ROOT, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(entry.name);
    }
  } catch (error) {
    usage(`catalog root is not readable at ${CATALOG_ROOT}: ${error instanceof Error ? error.message : String(error)}`);
  }
  directories.sort();

  const unhealthy = [];
  for (const name of directories) {
    const composition = join(CATALOG_ROOT, name, "agent.cordis.yml");
    try {
      const info = await stat(composition);
      if (!info.isFile()) unhealthy.push(`${name} (agent.cordis.yml is not a file)`);
    } catch {
      unhealthy.push(`${name} (agent.cordis.yml missing)`);
    }
  }
  if (unhealthy.length > 0) failures.push(`unhealthy preset directories: ${unhealthy.join("; ")}`);

  // A skipped patch is how "the file is right but it did not apply" surfaces.
  const notFoundWarnings = warnings.filter((message) => /not found|unknown/i.test(message));
  if (notFoundWarnings.length > 0) {
    failures.push(`composeEntries reported patch application warnings: ${notFoundWarnings.join(" | ")}`);
  }

  for (const failure of failures) process.stdout.write(`ROSTER_FAIL ${failure}\n`);
  process.stdout.write(
    `# presets healthy=${directories.length - unhealthy.length}/${directories.length} ` +
      `roots=${Array.isArray(config.roots) ? config.roots.length : 0} ` +
      `default=${JSON.stringify(config.default ?? null)} ` +
      `agent_presets_rows=${rows.length} warnings=${warnings.length}\n`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

// Run only when invoked as a script, so the exported assertion can be imported
// by a test without composing a real profile.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
