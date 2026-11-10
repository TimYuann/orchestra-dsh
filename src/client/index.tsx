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

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "settings.section": { kind: "list"; scope: "root"; owner: SettingsSectionOwnerProps };
  }
}
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import * as React from "react";
import { dictionaries } from "./locale.js";

const STATE_URL = "/plugins/orchestra-dsh/state";
const POLL_MS = 5000;

interface RoleSummary {
  id: string;
  name: string;
  /** Resolved node backend; absent on a deployment that predates the field. */
  execution?: string;
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
  execution?: string;
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
  border: "1px solid var(--dsw-alias-border-l1)",
  background: "var(--dsw-alias-bg-layer-1)",
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
  /** Resolved node backend (`session` | `subagent`) when the host reports one. */
  execution?: string;
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
          ...(r.execution === undefined ? {} : { execution: r.execution }),
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
  return `${r.name} (${r.id}) · ${r.execution === undefined ? "" : `${r.execution} · `}${r.status} · R${r.reportCount}${r.preset === undefined ? "" : ` · ${r.preset}`}${r.sandbox === undefined ? "" : ` · ${r.sandbox}`}${r.lastReport === null ? "" : ` · report: ${r.lastReport}`}${r.lastActivity === undefined ? "" : ` · last: ${r.lastActivity.slice(0, 60)}`}`;
}

/** Settings panel page: two display-only scrollable panes. */
export function OrchestraPanel({ t }: SettingsSectionOwnerProps & { t: (key: string) => string }): React.JSX.Element {
  const [snapshot, setSnapshot] = React.useState<StateSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [showTeams, setShowTeams] = React.useState(false);

  React.useEffect(() => {
    if (!showTeams) return;
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
  }, [showTeams]);

  return (
    <div style={{ padding: 16 }}>
      <h3>{t("title")}</h3>
      <p>{t("intro")}</p>
      <h4>{t("tools")}</h4>
      <p><code>a2a_create · a2a_send · a2a_reply · a2a_read · a2a_list · a2a_status · a2a_stop</code></p>
      <p style={{ color: "var(--dsw-alias-label-secondary)", fontSize: 12 }}>{t("delivery")}</p>
      <details onToggle={(event) => setShowTeams(event.currentTarget.open)}>
        <summary>{t("teams")}</summary>
        <p>{t("teamIntro")}</p>
      {error !== null ? (
        <div style={{ color: "var(--dsw-alias-state-error-primary)" }}>{t("unavailable")}: {error}</div>
      ) : snapshot === null ? (
        <div style={{ opacity: 0.6 }}>{t("loading")}</div>
      ) : (
        <>
          {/* 窗格 A：编排 / 组织 */}
          <section>
            <h4>{t("orchestrations")}</h4>
            <div style={PANE_STYLE}>
              <div style={{ marginBottom: 10 }}>
                <strong>{t("templates")}</strong>
                {snapshot.templates.map((template) => (
                  <div key={template.id} style={{ marginTop: 6 }}>
                    <div>
                      {template.name} <span style={{ opacity: 0.6 }}>({template.id} · {template.source})</span>
                    </div>
                    {template.description === undefined ? null : (
                      <div style={{ opacity: 0.75, fontSize: 12 }}>{template.description}</div>
                    )}
                    <div style={{ opacity: 0.55, fontSize: 12 }}>roles: {templateRolesSummary(template)}</div>
                    {templateProtocolSummary(template) === "" ? null : (
                      <div style={{ opacity: 0.5, fontSize: 11 }}>{templateProtocolSummary(template)}</div>
                    )}
                  </div>
                ))}
              </div>
              <div>
                <strong>{t("instances")}</strong>
                {snapshot.teams.length === 0 ? (
                  <div style={{ opacity: 0.55 }}>{t("none")}</div>
                ) : (
                  snapshot.teams.map((team) => (
                    <div key={teamKey(team)} style={{ marginTop: 6 }}>
                      <div>{teamLabel(team)}</div>
                      {team.archivePath === undefined
                        ? null
                        : <div style={{ opacity: 0.6, fontSize: 12 }}>{t("archive")}: {team.archivePath}</div>}
                      {team.teamId === "" ? null : (
                        <div style={{ opacity: 0.6, fontSize: 12 }}>{t("team")}: {team.teamId}</div>
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
            <h4>{t("roles")}</h4>
            <div style={PANE_STYLE}>
              <div style={{ marginBottom: 10 }}>
                <strong>{t("templateRoles")}</strong>
                {flattenTemplateRoles(snapshot.templates).length === 0 ? (
                  <div style={{ opacity: 0.55 }}>—</div>
                ) : (
                  flattenTemplateRoles(snapshot.templates).map((r) => (
                    <div key={r.id} style={{ marginTop: 4 }}>
                      {r.name} <span style={{ opacity: 0.6 }}>({r.id}
                        {r.execution === undefined ? "" : ` · ${r.execution}`}
                        {r.preset === undefined ? "" : ` · ${r.preset}`}
                        {r.sandbox === undefined ? "" : ` · ${r.sandbox}`})</span>{" "}
                      <span style={{ opacity: 0.6 }}>— {t("sources")}: {r.sources.join(", ")}</span>
                    </div>
                  ))
                )}
              </div>
              <div>
                <strong>{t("instanceRoles")}</strong>
                {snapshot.teams.length === 0 ? (
                  <div style={{ opacity: 0.55 }}>{t("none")}</div>
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
      </details>
    </div>
  );
}

/** Services required by the settings registration (Cordis inject contract). */
export const inject = ["slots", "locale"];

/**
 * Browser plugin: register the `settings.section` list entry.
 *
 * DSH 0.1.5-rc.2 made slot registration declaration-gated: `register()` throws
 * `slot "…" is not declared (a parent entry's children table must declare it)`
 * unless the slot's owner has already declared it. `ctx.slots.inject(key, cb)`
 * runs `cb` synchronously when the declaration exists and otherwise inside the
 * declaring `register()` call once it commits, so an entry may load before or
 * after the settings shell. The callback returns the registration's disposer,
 * which is exactly the effect contract `inject` expects; the controller rides
 * this plugin's fiber, so unload cancels a pending wait and removes the entry.
 *
 * @param ctx - client root context carrying the slot registry.
 */
export function apply(ctx: Context): void {
  for (const [language, dictionary] of Object.entries(dictionaries)) {
    ctx.effect(() => ctx.locale.register("orchestra-dsh", language, dictionary));
  }
  const t = ctx.locale.bind("orchestra-dsh");
  const Panel = (props: SettingsSectionOwnerProps) => {
    React.useSyncExternalStore((listener) => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot());
    return <OrchestraPanel {...props} t={t} />;
  };
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "orchestra",
        order: 200,
        label: () => t("title"),
      },
      Panel,
    ),
  );
}