/**
 * Orchestra Model Preferences store and tier mapping.
 *
 * Persists model tier mappings to <cwd>/orchestra/preferences.json with global
 * fallback to ~/.dsh/orchestra-preferences.json.
 *
 * Supports tiered intelligence:
 * - high_intelligence (Planner / Architect / Oracle / Driver)
 * - standard_work (Implementer / Reviewer)
 * - fast_verification (Verifier / Tests)
 *
 * @module orchestra-dsh/orchestra-preferences
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { ActiveTeamStateFileSystem } from "./orchestra-state.js";

export type IntelligenceTier = "high_intelligence" | "standard_work" | "fast_verification";

export interface ModelPreferenceConfig {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface OrchestraPreferences {
  schemaVersion: 1;
  tiers: {
    high_intelligence: ModelPreferenceConfig;
    standard_work: ModelPreferenceConfig;
    fast_verification: ModelPreferenceConfig;
  };
  roleMapping?: Record<string, IntelligenceTier>;
}

export const PREFERENCES_FILE_PATH = "orchestra/preferences.json";
export const GLOBAL_PREFERENCES_DIR = ".dsh";
export const GLOBAL_PREFERENCES_FILENAME = "orchestra-preferences.json";

export const DEFAULT_PREFERENCES: OrchestraPreferences = {
  schemaVersion: 1,
  tiers: {
    high_intelligence: {
      provider: "deepseek",
      model: "deepseek-reasoner",
      reasoningEffort: "high",
    },
    standard_work: {
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "medium",
    },
    fast_verification: {
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "low",
    },
  },
  roleMapping: {
    driver: "high_intelligence",
    planner: "high_intelligence",
    architect: "high_intelligence",
    oracle: "high_intelligence",
    implementer: "standard_work",
    reviewer: "standard_work",
    verifier: "fast_verification",
    tester: "fast_verification",
  },
};

export function validatePreferences(data: unknown): data is OrchestraPreferences {
  if (typeof data !== "object" || data === null) return false;
  const cand = data as Partial<OrchestraPreferences>;
  if (cand.schemaVersion !== 1) return false;
  if (typeof cand.tiers !== "object" || cand.tiers === null) return false;

  const validTiers: IntelligenceTier[] = ["high_intelligence", "standard_work", "fast_verification"];
  for (const tier of validTiers) {
    const config = cand.tiers[tier];
    if (typeof config !== "object" || config === null) return false;
    if (typeof config.provider !== "string" || config.provider.trim() === "") return false;
    if (typeof config.model !== "string" || config.model.trim() === "") return false;
    if (config.reasoningEffort !== undefined && typeof config.reasoningEffort !== "string") return false;
  }

  if (cand.roleMapping !== undefined) {
    if (typeof cand.roleMapping !== "object" || cand.roleMapping === null) return false;
    for (const [key, value] of Object.entries(cand.roleMapping)) {
      if (typeof key !== "string" || key.trim() === "") return false;
      if (!validTiers.includes(value as IntelligenceTier)) return false;
    }
  }

  return true;
}

export function resolveTierForRole(roleId: string, preferences?: OrchestraPreferences): IntelligenceTier {
  const normalized = roleId.toLowerCase().trim();
  if (preferences?.roleMapping && preferences.roleMapping[normalized] !== undefined) {
    return preferences.roleMapping[normalized];
  }
  if (["driver", "planner", "architect", "oracle", "lead"].some((k) => normalized.includes(k))) {
    return "high_intelligence";
  }
  if (["verifier", "test", "tester", "audit", "lint"].some((k) => normalized.includes(k))) {
    return "fast_verification";
  }
  return "standard_work";
}

/**
 * Resolve one role's model route.
 *
 * Precedence, highest first:
 *   1. the role's own `runtime` block in the topology (the author said so);
 *   2. the supplied preferences ladder, when a preference file exists;
 *   3. {@link DEFAULT_PREFERENCES} — a last-resort value for callers that have
 *      no deployment default in hand.
 *
 * Callers inside the plugin pass `preferences` ONLY when a preference file was
 * actually found. That is deliberate: a built-in ladder must never silently
 * reroute every role away from the deployment's configured default model.
 */
export function resolveModelForRole(
  roleId: string,
  roleRuntime?: { provider?: string; model?: string; reasoningEffort?: string },
  preferences?: OrchestraPreferences,
): ModelPreferenceConfig {
  if (roleRuntime?.provider !== undefined && roleRuntime?.model !== undefined && roleRuntime.provider !== "" && roleRuntime.model !== "") {
    return {
      provider: roleRuntime.provider,
      model: roleRuntime.model,
      ...(roleRuntime.reasoningEffort !== undefined ? { reasoningEffort: roleRuntime.reasoningEffort } : {}),
    };
  }
  const prefs = preferences ?? DEFAULT_PREFERENCES;
  const tier = resolveTierForRole(roleId, prefs);
  return prefs.tiers[tier];
}

export async function readPreferences(
  cwd: string,
  options?: { fs?: ActiveTeamStateFileSystem; globalRoot?: string },
): Promise<OrchestraPreferences | undefined> {
  // 1. Try project-level preferences file
  if (options?.fs) {
    try {
      const target = await options.fs.resolve(PREFERENCES_FILE_PATH, { cwd });
      const stat = await options.fs.stat(target);
      if (stat !== undefined) {
        const text = await options.fs.readText(target);
        const parsed = JSON.parse(text);
        if (validatePreferences(parsed)) return parsed;
      }
    } catch {
      // Ignore and fallback
    }
  } else {
    try {
      const text = await readFile(join(cwd, PREFERENCES_FILE_PATH), "utf8");
      const parsed = JSON.parse(text);
      if (validatePreferences(parsed)) return parsed;
    } catch {
      // Ignore and fallback
    }
  }

  // 2. Try global fallback preferences file
  const globalPath = options?.globalRoot
    ? join(options.globalRoot, GLOBAL_PREFERENCES_FILENAME)
    : join(homedir(), GLOBAL_PREFERENCES_DIR, GLOBAL_PREFERENCES_FILENAME);

  if (options?.fs) {
    try {
      const target = await options.fs.resolve(globalPath);
      const stat = await options.fs.stat(target);
      if (stat !== undefined) {
        const text = await options.fs.readText(target);
        const parsed = JSON.parse(text);
        if (validatePreferences(parsed)) return parsed;
      }
    } catch {
      // Ignore
    }
  } else {
    try {
      const text = await readFile(globalPath, "utf8");
      const parsed = JSON.parse(text);
      if (validatePreferences(parsed)) return parsed;
    } catch {
      // Ignore
    }
  }

  return undefined;
}

export async function writePreferences(
  cwd: string,
  preferences: OrchestraPreferences,
  options?: { fs?: ActiveTeamStateFileSystem; global?: boolean; globalRoot?: string },
): Promise<string> {
  if (!validatePreferences(preferences)) {
    throw new Error("Invalid OrchestraPreferences object");
  }

  const isGlobal = options?.global === true;
  const targetPath = isGlobal
    ? (options?.globalRoot
        ? join(options.globalRoot, GLOBAL_PREFERENCES_FILENAME)
        : join(homedir(), GLOBAL_PREFERENCES_DIR, GLOBAL_PREFERENCES_FILENAME))
    : join(cwd, PREFERENCES_FILE_PATH);

  const content = JSON.stringify(preferences, null, 2);

  if (options?.fs) {
    const target = await options.fs.resolve(targetPath, { cwd });
    await options.fs.writeText(target, content);
    return options.fs.processPath(target);
  } else {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, "utf8");
    return targetPath;
  }
}
