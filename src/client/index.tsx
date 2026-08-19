/**
 * orchestra-dsh client half: an "orchestra" page in the settings panel.
 *
 * Pure-display version (per user decision 2026-08-17): two scrollable panes —
 * 「编排/组织」(built-in + user topology templates, plus team instances) and
 * 「角色」(template roles plus instance roles). No buttons, no
 * openDocument, no create/edit interactions in this version. Built-in
 * templates are always shown even when the user has no GUI workspace and no
 * team data.
 *
 * Data comes from the host route /plugins/orchestra-dsh/state (polled).
 */

import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import * as React from "react";

const STATE_URL = "/plugins/orchestra-dsh/state";
const POLL_MS = 5000;

interface RoleSummary {
  id: string;
  name: string;
  preset?: string;
  sandbox?: string;
  maxRounds?: number;
}

interface TemplateSummary {
  id: string;
  name: string;
  description?: string;
  source: string;
  controller?: Record<string, unknown>;
  protocol?: Record<string, unknown>;
  roles: RoleSummary[];
}

interface InstanceRole {
  id: string;
  name: string;
  sessionId: string;
  preset?: string;
  sandbox?: string;
  live: boolean;
  status: string;
  reportCount: number;
  lastReport: string | null;
  lastActivity?: string;
}

interface TeamInstance {
  workspacePath: string;
  workspaceTitle?: string;
  teamId: string;
  status: string;
  goal: string;
  topology: string;
  createdAt: number;
  controllerSessionId: string;
  archived: boolean;
  archivePath?: string;
  roles: InstanceRole[];
}

interface StateSnapshot {
  templates: TemplateSummary[];
  teams: TeamInstance[];
}

function fetchState(): Promise<StateSnapshot> {
  return fetch(STATE_URL, { cache: "no-store" }).then((res) => {
    if (!res.ok) throw new Error(`orchestra state route ${res.status}`);
    return res.json() as Promise<StateSnapshot>;
  });
}

const PANE_STYLE: React.CSSProperties = {
  maxHeight: 320,
  overflowY: "auto",
  border: "1px solid var(--border-color, #333)",
  borderRadius: 8,
  padding: 12,
  marginBottom: 16,
};

function templateRolesSummary(t: TemplateSummary): string {
  return t.roles.map((r) => `${r.name} (${r.id})`).join(", ") || "—";
}

/** Compact protocol summary: ownership decisions + route kinds. */
function templateProtocolSummary(t: TemplateSummary): string {
  const protocol = t.protocol;
  if (protocol === undefined) return "";
  const parts: string[] = [];
  const ownership = protocol.ownership;
  if (typeof ownership === "object" && ownership !== null) {
    parts.push(
      `owns: ${Object.entries(ownership)
        .map(([decision, owner]) => `${decision}→${String(owner)}`)
        .join(", ")}`,
    );
  }
  const routes = protocol.routes;
  if (Array.isArray(routes)) {
    parts.push(
      `routes: ${routes
        .map((r) => `${String(r.kind)}: ${Array.isArray(r.from) ? r.from.join("+") : r.from}→${Array.isArray(r.to) ? r.to.join(",") : r.to}`)
        .join("; ")}`,
    );
  }
  return parts.join(" · ");
}

/** One flattened template role row: row-leading role name, deduped by role id. */
interface FlatTemplateRole {
  id: string;
  name: string;
  preset?: string;
  sandbox?: string;
  /** Template ids that define this role, in template order. */
  sources: string[];
}

/**
 * Aggregate every template's roles into a flat list, deduped by role id
 * (a role defined by several templates is listed once). When preset/sandbox
 * differ across templates, the first template's values win (template order =
 * user templates first, then bundled trio/duo/oracle) and the sources list
 * shows every template that defines the role.
 */
function flattenTemplateRoles(templates: TemplateSummary[]): FlatTemplateRole[] {
  const byId = new Map<string, FlatTemplateRole>();
  for (const t of templates) {
    for (const r of t.roles) {
      const existing = byId.get(r.id);
      if (existing === undefined) {
        byId.set(r.id, {
          id: r.id,
          name: r.name,
          ...(r.preset === undefined ? {} : { preset: r.preset }),
          ...(r.sandbox === undefined ? {} : { sandbox: r.sandbox }),
          sources: [t.id],
        });
      } else if (!existing.sources.includes(t.id)) {
        existing.sources.push(t.id);
      }
    }
  }
  return [...byId.values()];
}

function teamKey(team: TeamInstance): string {
  return `${team.workspacePath}:${team.archivePath === undefined ? "active" : team.archivePath}`;
}

function teamLabel(team: TeamInstance): string {
  const where =
    team.workspaceTitle === undefined ? team.workspacePath : `${team.workspaceTitle} — ${team.workspacePath}`;
  const goal = team.goal === "" ? "" : ` · “${team.goal.slice(0, 48)}${team.goal.length > 48 ? "…" : ""}”`;
  const created =
    team.createdAt === 0 ? "" : ` · created ${new Date(team.createdAt).toLocaleString()}`;
  return `${team.topology} · ${team.status}${goal}${created} · ${where === "" ? "" : where}`;
}

function instanceRoleLine(r: InstanceRole): string {
  return `${r.name} (${r.id}) · ${r.status} · R${r.reportCount}${r.preset === undefined ? "" : ` · ${r.preset}`}${r.sandbox === undefined ? "" : ` · ${r.sandbox}`}${r.lastReport === null ? "" : ` · report: ${r.lastReport}`}${r.lastActivity === undefined ? "" : ` · last: ${r.lastActivity.slice(0, 60)}`}`;
}

/** Settings panel page: two display-only scrollable panes. */
export function OrchestraPanel(): React.JSX.Element {
  const [snapshot, setSnapshot] = React.useState<StateSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const tick = (): void => {
      fetchState()
        .then((data) => {
          if (cancelled) return;
          setSnapshot(data);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
        });
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div style={{ padding: 16 }}>
      <h3>orchestra</h3>
      <p style={{ opacity: 0.7, fontSize: 12 }}>
        多角色拓扑协作 · 内置组织与角色恒显，团队实例尽力而为（轮询）。Multi-role topology collaboration: built-in
        orchestrations &amp; roles are always shown; team instances are best-effort (polled).
      </p>
      {error !== null ? (
        <div style={{ color: "#e88" }}>state unavailable: {error}</div>
      ) : snapshot === null ? (
        <div style={{ opacity: 0.6 }}>loading…</div>
      ) : (
        <>
          {/* 窗格 A：编排 / 组织 */}
          <section>
            <h4>编排 · Orchestrations</h4>
            <div style={PANE_STYLE}>
              <div style={{ marginBottom: 10 }}>
                <strong>版型 · Templates</strong>
                {snapshot.templates.map((t) => (
                  <div key={t.id} style={{ marginTop: 6 }}>
                    <div>
                      {t.name} <span style={{ opacity: 0.6 }}>({t.id} · {t.source})</span>
                    </div>
                    {t.description === undefined ? null : (
                      <div style={{ opacity: 0.75, fontSize: 12 }}>{t.description}</div>
                    )}
                    <div style={{ opacity: 0.55, fontSize: 12 }}>roles: {templateRolesSummary(t)}</div>
                    {templateProtocolSummary(t) === "" ? null : (
                      <div style={{ opacity: 0.5, fontSize: 11 }}>{templateProtocolSummary(t)}</div>
                    )}
                  </div>
                ))}
              </div>
              <div>
                <strong>团队实例 · Team instances</strong>
                {snapshot.teams.length === 0 ? (
                  <div style={{ opacity: 0.55 }}>（无团队实例）none yet</div>
                ) : (
                  snapshot.teams.map((team) => (
                    <div key={teamKey(team)} style={{ marginTop: 6 }}>
                      <div>{teamLabel(team)}</div>
                      {team.archivePath === undefined
                        ? null
                        : <div style={{ opacity: 0.6, fontSize: 12 }}>archive: {team.archivePath}</div>}
                      {team.teamId === "" ? null : (
                        <div style={{ opacity: 0.6, fontSize: 12 }}>team: {team.teamId}</div>
                      )}
                      <div style={{ opacity: 0.6, fontSize: 12 }}>
                        roles: {team.roles.map((r) => `${r.id} R${r.reportCount}`).join(", ") || "—"}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
          {/* 窗格 B：角色 */}
          <section>
            <h4>角色 · Roles</h4>
            <div style={PANE_STYLE}>
              <div style={{ marginBottom: 10 }}>
                <strong>版型角色 · Template roles</strong>
                {flattenTemplateRoles(snapshot.templates).length === 0 ? (
                  <div style={{ opacity: 0.55 }}>—</div>
                ) : (
                  flattenTemplateRoles(snapshot.templates).map((r) => (
                    <div key={r.id} style={{ marginTop: 4 }}>
                      {r.name} <span style={{ opacity: 0.6 }}>({r.id}
                        {r.preset === undefined ? "" : ` · ${r.preset}`}
                        {r.sandbox === undefined ? "" : ` · ${r.sandbox}`})</span>{" "}
                      <span style={{ opacity: 0.6 }}>— 来源: {r.sources.join(", ")}</span>
                    </div>
                  ))
                )}
              </div>
              <div>
                <strong>实例角色 · Instance roles</strong>
                {snapshot.teams.length === 0 ? (
                  <div style={{ opacity: 0.55 }}>（无团队实例）none yet</div>
                ) : (
                  snapshot.teams.map((team) => (
                    <div key={teamKey(team)} style={{ marginTop: 6 }}>
                      <div style={{ opacity: 0.7, fontSize: 12 }}>{teamLabel(team)}</div>
                      {team.roles.map((r) => (
                        <div key={r.sessionId} style={{ marginTop: 2, fontFamily: "monospace", fontSize: 12 }}>
                          {instanceRoleLine(r)}
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/** Services required by the settings registration (Cordis inject contract). */
export const inject = ["slots"];

/** Browser plugin: register the settings.section list entry. */
export function apply(ctx: ClientContext): void {
  ctx.slots.register(
    {
      name: "settings.section",
      id: "orchestra",
      order: 200,
      label: "orchestra",
    },
    OrchestraPanel,
  );
}