/** Governed teamId+roleId address resolution. No title/name/cwd scanning. */

import type { ActiveTeamStateStore, TeamRole, TeamStatus } from "./orchestra-state.js";

export interface GovernedRoleAddress {
  team_id: string;
  role_id: string;
  resolved_session_id: string;
  team_status: "active" | "degraded";
  role_phase: "active";
  preset: string | null;
  sandbox: string;
  session_history: TeamRole["sessionHistory"];
}

export type GovernedAddressErrorCode = "missing" | "blocked" | "inactive" | "team_mismatch" | "team_unavailable" | "role_missing" | "role_not_active";

export class GovernedAddressError extends Error {
  readonly code: GovernedAddressErrorCode;
  constructor(code: GovernedAddressErrorCode, message: string) {
    super(message);
    this.name = "GovernedAddressError";
    this.code = code;
  }
}

export interface GovernedRoleAddressResolver {
  resolve(cwd: string, teamId: string, roleId: string, options?: { signal?: AbortSignal }): Promise<GovernedRoleAddress>;
}

function usableTeamStatus(status: TeamStatus): status is "active" | "degraded" {
  return status === "active" || status === "degraded";
}

export function createGovernedRoleAddressResolver(activeTeamState: ActiveTeamStateStore): GovernedRoleAddressResolver {
  return {
    async resolve(cwd, teamId, roleId, options = {}) {
      if (typeof teamId !== "string" || teamId === "" || typeof roleId !== "string" || roleId === "") {
        throw new GovernedAddressError("team_unavailable", "teamId and roleId must be non-empty");
      }
      const observed = await activeTeamState.read(cwd, { signal: options.signal });
      if (observed.kind === "missing") throw new GovernedAddressError("missing", `no Governed Team exists at cwd=${cwd}`);
      if (observed.kind === "inactive") throw new GovernedAddressError("inactive", `Team at cwd=${cwd} is inactive`);
      if (observed.kind === "blocked") throw new GovernedAddressError("blocked", `Team state is blocked (${observed.diagnostic.code}): ${observed.diagnostic.message}`);
      if (observed.team.teamId !== teamId) throw new GovernedAddressError("team_mismatch", `teamId ${teamId} does not match current Team ${observed.team.teamId}`);
      if (!usableTeamStatus(observed.team.status)) throw new GovernedAddressError("team_unavailable", `Team ${teamId} is ${observed.team.status}, not addressable`);
      const role = observed.team.roles.find((entry) => entry.id.toLowerCase() === roleId.toLowerCase());
      if (role === undefined) throw new GovernedAddressError("role_missing", `roleId ${roleId} is not in Team ${teamId}`);
      if (role.phase !== "active") throw new GovernedAddressError("role_not_active", `roleId ${role.id} is ${role.phase}, not active`);
      return {
        team_id: observed.team.teamId,
        role_id: role.id,
        resolved_session_id: role.sessionId,
        team_status: observed.team.status,
        role_phase: "active",
        preset: role.preset,
        sandbox: role.sandbox,
        session_history: role.sessionHistory,
      };
    },
  };
}
