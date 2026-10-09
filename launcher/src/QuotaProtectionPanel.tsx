import { useEffect, useState } from "react";
import type { Copy } from "./i18n";
import type { LauncherApi, QuotaSettings } from "./types";

const percentFields = [
  ["fiveHourReservePercent", "quotaFiveHourReserve"],
  ["fiveHourAdmissionPercent", "quotaFiveHourAdmission"],
  ["weeklyReservePercent", "quotaWeeklyReserve"],
  ["weeklyAdmissionPercent", "quotaWeeklyAdmission"],
] as const;

function invalidFields(policy: QuotaSettings["policy"]): Set<keyof QuotaSettings["policy"]> {
  const invalid = new Set<keyof QuotaSettings["policy"]>();
  for (const [field] of percentFields) {
    if (!Number.isFinite(policy[field]) || policy[field] < 0 || policy[field] > 100) invalid.add(field);
  }
  if (policy.fiveHourAdmissionPercent <= policy.fiveHourReservePercent) invalid.add("fiveHourAdmissionPercent");
  if (policy.weeklyAdmissionPercent <= policy.weeklyReservePercent) invalid.add("weeklyAdmissionPercent");
  return invalid;
}

export function QuotaProtectionPanel({ api, copy, available }: {
  api: LauncherApi;
  copy: Copy;
  available: boolean;
}) {
  const [saved, setSaved] = useState<QuotaSettings | null>(null);
  const [draft, setDraft] = useState<QuotaSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!available) {
      setLoading(false);
      return;
    }
    let active = true;
    void api.getQuotaSettings().then(settings => {
      if (!active) return;
      setSaved(settings);
      setDraft(settings);
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, available]);

  const modified = !!saved && !!draft && JSON.stringify(saved) !== JSON.stringify(draft);
  const invalid = draft ? invalidFields(draft.policy) : new Set<keyof QuotaSettings["policy"]>();
  const hasInvalid = invalid.size > 0;
  const restoreHiddenInvalidFields = (settings: QuotaSettings): QuotaSettings => {
    if (!invalidFields(settings.policy).size || !saved) return settings;
    return {
      ...settings,
      policy: {
        ...settings.policy,
        fiveHourReservePercent: saved.policy.fiveHourReservePercent,
        fiveHourAdmissionPercent: saved.policy.fiveHourAdmissionPercent,
        weeklyReservePercent: saved.policy.weeklyReservePercent,
        weeklyAdmissionPercent: saved.policy.weeklyAdmissionPercent,
      },
    };
  };
  const setPolicy = <K extends keyof QuotaSettings["policy"]>(key: K, value: QuotaSettings["policy"][K]) => {
    setDraft(previous => {
      if (!previous) return previous;
      const next = { ...previous, policy: { ...previous.policy, [key]: value } };
      return key === "mode" && value === "strict" ? restoreHiddenInvalidFields(next) : next;
    });
    setSuccess(false);
  };
  const save = async () => {
    if (!draft || hasInvalid || !modified) return;
    setBusy(true);
    setError(null);
    setSuccess(false);
    try {
      const result = await api.setQuotaSettings(draft);
      const current = { enabled: result.enabled, policy: result.policy };
      setSaved(current);
      setDraft(current);
      setSuccess(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  if (!available) return <p className="settings-experiments-note">{copy.quotaUnavailable}</p>;
  if (loading) return <p role="status" className="settings-experiments-note">{copy.quotaLoading}</p>;
  if (!draft) return <p role="alert" className="agent-field-error">{error ?? copy.quotaUnavailable}</p>;

  return (
    <div className="quota-guard-panel">
      <p className="settings-experiments-note">{copy.quotaBody}</p>
      <label className="quota-toggle-row">
        <input type="checkbox" checked={draft.enabled} disabled={busy}
          onChange={event => { setDraft(previous => previous
            ? event.target.checked ? { ...previous, enabled: true } : restoreHiddenInvalidFields({ ...previous, enabled: false })
            : previous); setSuccess(false); }} />
        <strong>{copy.quotaEnable}</strong>
      </label>
      {draft.enabled && <>
        <fieldset className="quota-modes" disabled={busy}>
          <legend>{copy.quotaTitle}</legend>
          {(["strict", "conservative"] as const).map(mode => (
            <label className={`quota-mode${draft.policy.mode === mode ? " is-selected" : ""}`} key={mode}>
              <span><input type="radio" name="quota-mode" checked={draft.policy.mode === mode}
                onChange={() => setPolicy("mode", mode)} />
                <strong>{mode === "strict" ? copy.quotaStrict : copy.quotaConservative}</strong>
              </span>
              <small>{mode === "strict" ? copy.quotaStrictBody : copy.quotaConservativeBody}</small>
            </label>
          ))}
        </fieldset>
        {draft.policy.mode === "conservative" && <div className="quota-percent-grid">
          {percentFields.map(([field, label]) => <label className="quota-percent-field" key={field}>
            {copy[label]}
            <input type="number" min={0} max={100} step={1} disabled={busy} value={Number.isNaN(draft.policy[field]) ? "" : draft.policy[field]}
              aria-invalid={invalid.has(field)}
              aria-describedby={invalid.has(field) ? "quota-validation-error" : undefined}
              onChange={event => setPolicy(field, event.target.value === "" ? Number.NaN : Number(event.target.value))} />
          </label>)}
        </div>}
      </>}
      {hasInvalid && <p id="quota-validation-error" role="alert" className="agent-field-error">{copy.quotaValidation}</p>}
      <p className="settings-experiments-note">{copy.quotaRestartHint}</p>
      {modified && <div className="quota-save-actions">
        <span role="status">{copy.quotaDraft}</span>
        <button type="button" className="button-secondary" disabled={busy}
          onClick={() => { setDraft(saved); setError(null); setSuccess(false); }}>{copy.quotaDiscard}</button>
        <button type="button" className="button-primary" disabled={busy || hasInvalid}
          onClick={() => void save()}>{copy.quotaSave}</button>
      </div>}
      {success && <p role="status" className="agent-feedback is-success">{copy.quotaSaved}</p>}
      {error && <p role="alert" className="agent-field-error">{error}</p>}
    </div>
  );
}
