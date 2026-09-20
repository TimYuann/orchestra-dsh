/**
 * Step-1 probe: does the REAL roster discovery find the 12 catalog preset ids?
 *
 * Correct harnessBase is a directory FILE URL (dsh-cordis-host-runner's own
 * directory) — the first attempt passed a filesystem path, which made every
 * preset, including shipped ones, report "Invalid URL". The shipped-preset
 * control below is what caught that.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";

const dshRoot = join(process.execPath, "..", "..", "lib", "node_modules", "@deepseek-ai", "dsh");
const hostNM = join(dshRoot, "node_modules", "@deepseek-ai");
const require = createRequire(join(hostNM, "dsh-agent-presets", "package.json"));
const load = (name) => import(require.resolve(name));

const presetsPkg = await load("@deepseek-ai/dsh-agent-presets");
const appBoot = await load("@deepseek-ai/dsh-app-boot");

const home = join(homedir(), ".dsh");
const profileDir = join(home, "profiles", "dev");
const profile = appBoot.loadProfileDirectory("dsh", profileDir, join(dshRoot, "package.json"), { userLayer: false });
const profilePatches = profile.patches.length > 0 ? profile.patches : (appBoot.loadOptionalPatches("dsh", join(profileDir, "cordis.patch.yml")) ?? []);
const homePatches = appBoot.loadOptionalPatches("dsh", join(home, "cordis.patch.yml")) ?? [];
const composed = appBoot.composeEntries([...profile.layers.flatMap((l) => l.patches), ...profilePatches, ...homePatches]);
const config = composed.filter((e) => e.id === "agent-presets")[0].config;

// The real harnessBase: the directory of the runner that loads the composition.
const runnerDir = join(hostNM, "dsh-cordis-host-runner", "lib") + "/";
const harnessBase = new URL(".", pathToFileURL(join(runnerDir, "index.js"))).href;
console.log("harnessBase:", harnessBase);

const shipped = presetsPkg.SHIPPED_PRESET_ROOT;
const catalog = join(home, "orchestra", "catalog-presets");
const roots = [
  { path: shipped, trust: "system" },
  ...config.roots.map((r) => ({ path: r.path, trust: r.trust ?? "user" })),
  { path: join(home, ".agent-presets"), trust: "user" },
];

const discovered = await presetsPkg.discoverPresets(roots, harnessBase);
const byId = new Map(discovered.map((p) => [p.id, p]));
console.log("roster size:", discovered.length);

// CONTROL: the shipped presets must be healthy. If they are, a BROKEN verdict on
// a catalog preset is a real finding rather than a harness artifact.
const shippedIds = ["standard", "minimal", "ptc", "cordis"];
console.log("CONTROL (shipped presets):");
for (const id of shippedIds) {
  const found = byId.get(id);
  console.log("  ", id.padEnd(12), found === undefined ? "absent" : found.broken === undefined ? "healthy" : "BROKEN: " + found.broken);
}

const ids = (await readdir(catalog, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
let ok = 0;
const failed = [];
console.log("CATALOG (the 12 orchestra-* presets):");
for (const id of ids) {
  const found = byId.get(id);
  if (found === undefined) {
    console.log("  RESOLVE_FAIL", id.padEnd(34), "not on the roster");
    failed.push(id);
    continue;
  }
  if (found.broken !== undefined) {
    console.log("  RESOLVE_BROKEN", id.padEnd(32), found.broken);
    failed.push(id);
    continue;
  }
  console.log("  RESOLVE_OK  ", id.padEnd(34), "trust=" + found.trust, "from_catalog=" + found.path.startsWith(catalog));
  ok += 1;
}
console.log(`# probe ids=${ids.length} ok=${ok} fail=${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
