import { useEffect, useState } from "react";
import { copyFor, localizeAgentStatus, localizeAgentWarning } from "./i18n";
import type { Language } from "./types";
import type { AgentManagerApi, AgentManagerInspection, AgentManagerPreview, AgentRoleEdit } from "./agent-manager-types";

export function AgentManagerPanel({ api, language = "en", browserCapacity, onSetBrowserCapacity }: {
  api: AgentManagerApi;
  language?: Language;
  browserCapacity?: number;
  onSetBrowserCapacity?: (value: number) => Promise<void>;
}) {
  const copy = copyFor(language);
  const [inspection, setInspection] = useState<AgentManagerInspection | null>(null);
  const [preset, setPreset] = useState<"balanced" | "parallel">("balanced");
  const [maxConcurrentThreads, setMaxConcurrentThreads] = useState(4);
  const [enrollMissingRoles, setEnrollMissingRoles] = useState(false);
  const [roleEdits, setRoleEdits] = useState<Record<string, AgentRoleEdit>>({});
  const [preview, setPreview] = useState<AgentManagerPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restart, setRestart] = useState(false);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const next = await api.inspect();
      setInspection(next);
      setRoleEdits({});
      setMaxConcurrentThreads(next.maxConcurrentThreads ?? 4);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void refresh(); }, [api]);

  const editRole = (name: string, field: keyof AgentRoleEdit, value: string) => {
    setRoleEdits(existing => {
      const patch = { ...existing[name] };
      if (value) patch[field] = value as never;
      else delete patch[field];
      const next = { ...existing };
      if (Object.keys(patch).length) next[name] = patch;
      else delete next[name];
      return next;
    });
    setPreview(null);
  };
  const suggestedCapacity = preset === "parallel" ? 8 : 6;

  const createPreview = async () => {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      if (!Number.isInteger(maxConcurrentThreads) || maxConcurrentThreads < 1 || maxConcurrentThreads > 8) {
        throw new Error(copy.agentThreadsValidation);
      }
      setPreview(await api.preview({
        preset, maxConcurrentThreads, enrollMissingRoles,
        ...(Object.keys(roleEdits).length ? { roles: roleEdits } : {}),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.apply(preview.id);
      setRestart(result.requiresRestart);
      setPreview(null);
      const next = await api.inspect();
      setInspection(next);
      setRoleEdits({});
      setMaxConcurrentThreads(next.maxConcurrentThreads ?? 4);
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const recover = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.recover();
      setInspection(await api.inspect());
      setPreview(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  return (
    <section aria-label={copy.agentTitle} className="settings-list" style={{ marginTop: 24 }}>
      <h2>{copy.agentTitle}</h2>
      <p>{copy.agentIntro}</p>
      <div className="manual-turn-actions">
        <button disabled={busy} onClick={() => void refresh()} type="button">{copy.agentReload}</button>
      </div>
      {inspection && <>
        <p><strong>{copy.agentCurrent}</strong> — <code>{inspection.codexHome}</code></p>
        {inspection.roles.length === 0 ? <p>{copy.agentNoAgents}</p> : (
          <div>
            {inspection.roles.map((role) => (
              <div className="agent-role-row" key={`${role.scope}:${role.name}`}>
                <div className="agent-role-summary">
                  <strong>{role.name}</strong>
                  <small>{copy.agentModel}: {role.model} · {copy.agentEffort}: {role.reasoningEffort ?? "—"}</small>
                  <small>{copy.agentStatus}: {localizeAgentStatus(copy, role.status)} · {role.managed ? copy.agentManaged : copy.agentUnmanaged}</small>
                  <small><code>{role.configPath}</code></small>
                </div>
                {role.configPath !== "—" && <details className="agent-role-details">
                  <summary>{copy.agentEdit}</summary>
                  <p>{copy.agentPermission}</p>
                  {role.policy !== "web-only" && <>
                    <p role="alert">{copy.agentRouteWarning}</p>
                    <label>
                      <input type="checkbox" disabled={busy}
                        checked={roleEdits[role.name]?.model === "chatgpt-web/gpt-6-sol"}
                        onChange={event => {
                          if (event.target.checked) editRole(role.name, "model", "chatgpt-web/gpt-6-sol");
                          else {
                            setRoleEdits(old => {
                              const next = { ...old, [role.name]: { ...old[role.name] } };
                              delete next[role.name].model;
                              return next;
                            });
                            setPreview(null);
                          }
                        }} />
                      {copy.agentRepairRoute}
                    </label>
                  </>}
                  <label className="agent-role-field">{copy.agentRoleEffort}
                    <select disabled={busy} value={roleEdits[role.name]?.reasoningEffort ?? ""}
                      onChange={event => editRole(role.name, "reasoningEffort", event.target.value)}>
                      <option value="">{copy.agentKeep} ({role.reasoningEffort ?? "—"})</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                    </select>
                  </label>
                  <label className="agent-role-field">{copy.agentRoleSandbox}
                    <select disabled={busy} value={roleEdits[role.name]?.sandboxMode ?? ""}
                      onChange={event => editRole(role.name, "sandboxMode", event.target.value)}>
                      <option value="">{copy.agentKeep} ({role.sandboxMode ?? "—"})</option>
                      <option value="read-only">read-only</option>
                      {role.name === "zam-builder" && <option value="workspace-write">workspace-write</option>}
                    </select>
                  </label>
                  <label className="agent-role-field">{copy.agentRoleInstructions}
                    <textarea disabled={busy} rows={6}
                      value={roleEdits[role.name]?.developerInstructions ?? role.developerInstructions ?? ""}
                      onChange={event => editRole(role.name, "developerInstructions", event.target.value)} />
                  </label>
                  {roleEdits[role.name] && <small>{copy.agentModified}</small>}
                </details>}
              </div>
            ))}
          </div>
        )}
        {inspection.warnings.map((warning, i) => <p key={i} role="status">{localizeAgentWarning(copy, warning)}</p>)}
        {inspection.pendingRecovery && <>
          <p role="alert">{copy.agentPending}</p>
          <button disabled={busy} onClick={() => void recover()} type="button">{copy.agentRecover}</button>
        </>}
        <label style={{ display: "block", marginTop: 12 }}>
          {copy.agentPreset}
          <select disabled={busy} value={preset} onChange={(event) => {
            const next = event.target.value as typeof preset;
            setPreset(next);
            setMaxConcurrentThreads(next === "parallel" ? 6 : 4);
            setPreview(null);
          }}>
            <option value="balanced">{copy.agentBalanced}</option>
            <option value="parallel">{copy.agentParallel}</option>
          </select>
        </label>
        {browserCapacity !== undefined && <p role="status">
          {copy.agentCapacitySuggestion.replace("{count}", String(suggestedCapacity)).replace("{current}", String(browserCapacity))}
          {browserCapacity !== suggestedCapacity && onSetBrowserCapacity && <button type="button" disabled={busy}
            onClick={() => { void onSetBrowserCapacity(suggestedCapacity).catch(cause => setError(String(cause))); }}>
            {copy.agentSetCapacity}
          </button>}
        </p>}
        <label style={{ display: "block", marginTop: 12 }}>
          {copy.agentThreads}
          <input disabled={busy} type="number" min={1} max={8} step={1} value={maxConcurrentThreads}
            onChange={(event) => { setMaxConcurrentThreads(Number(event.target.value)); setPreview(null); }} />
        </label>
        <label style={{ display: "block", marginTop: 12 }}>
          <input type="checkbox" checked={enrollMissingRoles} disabled={busy}
            onChange={(event) => { setEnrollMissingRoles(event.target.checked); setPreview(null); }} />
          {copy.agentEnroll}
        </label>
        <div className="manual-turn-actions" style={{ marginTop: 12 }}>
          <button disabled={busy || inspection.pendingRecovery} onClick={() => void createPreview()} type="button">{copy.agentPreview}</button>
        </div>
      </>}
      {preview && <div aria-label={copy.agentPreview}>
        {preview.warnings.map((warning, i) => <p key={i} role="status">{localizeAgentWarning(copy, warning)}</p>)}
        {preview.changes.length === 0 ? <p>{copy.agentNoChanges}</p> : preview.changes.map((item) => (
          <details key={item.path} open>
            <summary><code>{item.path}</code></summary>
            <p>{item.operation}: {item.changedKeys.join(", ")}</p>
          </details>
        ))}
        <div className="manual-turn-actions">
          <button disabled={busy || inspection?.pendingRecovery === true || preview.changes.length === 0}
            onClick={() => void apply()} type="button">{copy.agentApply}</button>
        </div>
      </div>}
      {restart && <p role="status">{copy.agentRestart}</p>}
      {error && <p role="alert">{error.includes("stale") ? copy.agentStale : error}</p>}
    </section>
  );
}
