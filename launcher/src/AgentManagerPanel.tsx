import { useEffect, useState } from "react";
import { copyFor, localizeAgentStatus, localizeAgentWarning } from "./i18n";
import type { Language } from "./types";
import type { AgentManagerApi, AgentManagerInspection, AgentManagerPreview, AgentRoleEdit, AgentWorkflowPreset } from "./agent-manager-types";

// The named preset is UI shorthand for the native Codex child-thread limit.
// The native config stores the limit, not a separate preset name.
export function presetFromThreadLimit(threads: number | null): AgentWorkflowPreset {
  return threads === 6 ? "parallel" : threads === 4 || threads === null ? "balanced" : "custom";
}

export function AgentManagerPanel({ api, language = "en", browserCapacity, effectiveBrowserCapacity, onSetBrowserCapacity }: {
  api: AgentManagerApi;
  language?: Language;
  browserCapacity?: number;
  effectiveBrowserCapacity?: number;
  onSetBrowserCapacity?: (value: number) => Promise<void>;
}) {
  const copy = copyFor(language);
  const [inspection, setInspection] = useState<AgentManagerInspection | null>(null);
  const [preset, setPreset] = useState<AgentWorkflowPreset>("balanced");
  const [maxConcurrentThreads, setMaxConcurrentThreads] = useState(4);
  const [enrollMissingRoles, setEnrollMissingRoles] = useState(false);
  const [roleEdits, setRoleEdits] = useState<Record<string, AgentRoleEdit>>({});
  const [preview, setPreview] = useState<AgentManagerPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restart, setRestart] = useState(false);
  const [loading, setLoading] = useState(true);

  const showInspection = (next: AgentManagerInspection) => {
    setInspection(next);
    setRoleEdits({});
    setPreset(presetFromThreadLimit(next.maxConcurrentThreads));
    setMaxConcurrentThreads(next.maxConcurrentThreads ?? 4);
  };

  const refresh = async () => {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const next = await api.inspect();
      showInspection(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, [api]);

  const editRole = (name: string, field: keyof AgentRoleEdit, value: string) => {
    setRoleEdits(existing => {
      const patch = { ...existing[name] };
      const saved = inspection?.roles.find(role => role.name === name)?.[field];
      if (value && value !== saved) patch[field] = value as never;
      else delete patch[field];
      const next = { ...existing };
      if (Object.keys(patch).length) next[name] = patch;
      else delete next[name];
      return next;
    });
    setPreview(null);
  };
  const suggestedCapacity = preset === "parallel" ? 8 : preset === "balanced" ? 6 : undefined;
  const hasDraft = inspection !== null && (
    maxConcurrentThreads !== inspection.maxConcurrentThreads || enrollMissingRoles || Object.keys(roleEdits).length > 0
  );
  const threadLimitInvalid = !Number.isInteger(maxConcurrentThreads) || maxConcurrentThreads < 1 || maxConcurrentThreads > 8;

  const resetDraft = () => {
    if (!inspection) return;
    setPreset(presetFromThreadLimit(inspection.maxConcurrentThreads));
    setMaxConcurrentThreads(inspection.maxConcurrentThreads ?? 4);
    setEnrollMissingRoles(false);
    setRoleEdits({});
    setPreview(null);
    setError(null);
  };

  const createPreview = async () => {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      if (threadLimitInvalid) {
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
      showInspection(next);
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
      showInspection(await api.inspect());
      setPreview(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  return (
    <section aria-label={copy.agentTitle} className="agent-manager-panel">
      <p className="agent-panel-intro">{copy.agentIntro}</p>
      <div className="agent-panel-heading">
        <h3>{copy.agentWorkflowHeading}</h3>
        <button className="button-secondary" disabled={busy} onClick={() => void refresh()} type="button">{copy.agentReload}</button>
      </div>
      {loading && <p role="status">{copy.agentLoading}</p>}
      {inspection && <>
        <div className="agent-workflow-panel">
          <div className="agent-saved-row">
            <span className="agent-state-chip">{copy.agentSavedThreads.replace("{count}", inspection.maxConcurrentThreads === null ? "—" : String(inspection.maxConcurrentThreads))}</span>
            <span className={`agent-state-chip${hasDraft ? " is-draft" : ""}`}>
              {hasDraft ? copy.agentDraftStatus : copy.agentSavedStatus}
            </span>
          </div>
          <fieldset className="agent-preset-fieldset">
            <legend>{copy.agentPreset}</legend>
            <div className="agent-preset-grid">
              {(["balanced", "parallel"] as const).map(value => (
                <label className={`agent-preset-card${preset === value ? " is-selected" : ""}`} key={value}>
                  <span className="agent-preset-heading">
                    <input type="radio" name="agent-workflow-preset" value={value} checked={preset === value}
                      disabled={busy} onChange={() => {
                        setPreset(value);
                        setMaxConcurrentThreads(value === "parallel" ? 6 : 4);
                        setPreview(null);
                      }} />
                    <strong>{value === "balanced" ? copy.agentBalanced : copy.agentParallel}</strong>
                  </span>
                  <small>{copy.agentPresetDetails.replace("{threads}", value === "balanced" ? "4" : "6").replace("{browser}", value === "balanced" ? "6" : "8")}</small>
                </label>
              ))}
              {preset === "custom" && <label className="agent-preset-card is-selected">
                <span className="agent-preset-heading">
                  <input type="radio" name="agent-workflow-preset" value="custom" checked readOnly />
                  <strong>{copy.agentCustom}</strong>
                </span>
                <small>{copy.agentCustomDetails}</small>
              </label>}
            </div>
          </fieldset>
          <label className="agent-limit-field">{copy.agentThreads}
            <input disabled={busy} type="number" min={1} max={8} step={1} value={maxConcurrentThreads}
              aria-invalid={threadLimitInvalid} aria-describedby={threadLimitInvalid ? "agent-thread-limit-error" : undefined}
              onChange={event => {
                const count = event.target.value === "" ? 0 : Number(event.target.value);
                setMaxConcurrentThreads(count);
                setPreset(presetFromThreadLimit(count));
                setPreview(null);
              }} />
          </label>
          {threadLimitInvalid && <p id="agent-thread-limit-error" role="alert" className="agent-field-error">{copy.agentThreadsValidation}</p>}
          <p className="agent-field-hint">{copy.agentPresetSaveHint}</p>
          {browserCapacity !== undefined && <div className="agent-capacity-note">
            <div>
              <strong>{copy.browserCapacityTitle}: {browserCapacity}</strong>
              {effectiveBrowserCapacity !== undefined && <p className="agent-capacity-effective">
                {copy.agentEffectiveCapacity.replace("{count}", String(effectiveBrowserCapacity))}
                {effectiveBrowserCapacity !== browserCapacity && <span className="agent-pending-notice"> {copy.agentPendingCapacity}</span>}
              </p>}
              <p>{suggestedCapacity === undefined ? copy.agentCustomCapacityHint : copy.agentCapacitySuggestion.replace("{count}", String(suggestedCapacity)).replace("{current}", String(browserCapacity))}</p>
            </div>
            {suggestedCapacity !== undefined && browserCapacity !== suggestedCapacity && onSetBrowserCapacity &&
              <button type="button" className="button-secondary" disabled={busy}
                onClick={() => { void onSetBrowserCapacity(suggestedCapacity).catch(cause => setError(String(cause))); }}>
                {copy.agentSetCapacity}
              </button>}
          </div>}
        </div>
        <div className="agent-panel-heading agent-roles-heading">
          <h3>{copy.agentCurrent}</h3>
          <code title={inspection.codexHome}>{inspection.codexHome}</code>
        </div>
        {inspection.roles.length === 0 ? <p>{copy.agentNoAgents}</p> : (
          <div className="agent-roles-grid">
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
                            editRole(role.name, "model", "");
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
        <label className="agent-enroll-field">
          <input type="checkbox" checked={enrollMissingRoles} disabled={busy}
            onChange={(event) => { setEnrollMissingRoles(event.target.checked); setPreview(null); }} />
          {copy.agentEnroll}
        </label>
      </>}
      {preview && <div aria-label={copy.agentPreview} className="agent-preview-panel">
        <h3>{copy.agentReviewHeading}</h3>
        {preview.warnings.map((warning, i) => <p key={i} role="status">{localizeAgentWarning(copy, warning)}</p>)}
        {preview.changes.length === 0 ? <p>{copy.agentNoChanges}</p> : preview.changes.map((item) => (
          <details key={item.path} open>
            <summary><code>{item.path}</code></summary>
            <p>{item.operation}: {item.changedKeys.join(", ")}</p>
          </details>
        ))}
      </div>}
      {inspection && (hasDraft || preview) && <div className="agent-save-bar">
        <span role="status" aria-live="polite">{hasDraft ? copy.agentDraftStatus : copy.agentSavedStatus}</span>
        <div className="agent-save-actions">
          {hasDraft && <button className="button-secondary" disabled={busy} onClick={resetDraft} type="button">{copy.agentDiscard}</button>}
          {preview?.changes.length ?
            <button className="button-primary" disabled={busy || inspection.pendingRecovery}
              onClick={() => void apply()} type="button">{copy.agentApply}</button> :
            <button className="button-primary" disabled={busy || inspection.pendingRecovery || !hasDraft || threadLimitInvalid}
              onClick={() => void createPreview()} type="button">{copy.agentPreview}</button>}
        </div>
      </div>}
      {restart && <p role="status" className="agent-feedback is-success">{copy.agentRestart}</p>}
      {error && <p role="alert">{error.includes("stale") ? copy.agentStale : error}</p>}
    </section>
  );
}
