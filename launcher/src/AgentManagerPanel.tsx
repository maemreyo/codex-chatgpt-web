import { useEffect, useState } from "react";
import type { AgentManagerApi, AgentManagerInspection, AgentManagerPreview } from "./agent-manager-types";

const en = {
  title: "Agents & Runtime",
  intro: "Inspect your existing Codex agents before adopting a managed workflow. Manual configuration is preserved until you approve a preview.",
  reload: "Refresh",
  current: "Current Codex agents",
  unmanaged: "External",
  managed: "Managed",
  status: "Status",
  model: "Model",
  effort: "Effort",
  threads: "Concurrent child threads",
  preset: "Workflow preset",
  balanced: "Balanced — one builder and a reviewer",
  parallel: "Parallel — requires higher browser capacity",
  enroll: "Register missing Zam agents using default templates",
  preview: "Preview changes",
  apply: "Apply preview",
  restart: "Start a new Codex session for these changes to take effect.",
  pending: "A recovery transaction needs attention. Applying another change is disabled.",
  recover: "Recover unfinished changes",
  noAgents: "No registered Zam roles found in the selected Codex profile.",
  noChanges: "No file changes are needed.",
  stale: "Preview expired after configuration changed. Refresh and preview again.",
};

const vi: typeof en = {
  title: "Agents & Runtime",
  intro: "Kiểm tra các agent Codex đang dùng trước khi nhận quản lý. Cấu hình chỉnh tay được giữ nguyên cho đến khi bạn duyệt bản xem trước.",
  reload: "Làm mới",
  current: "Các agent Codex hiện tại",
  unmanaged: "Bên ngoài",
  managed: "Đang quản lý",
  status: "Trạng thái",
  model: "Model",
  effort: "Effort",
  threads: "Số child threads song song",
  preset: "Preset workflow",
  balanced: "Balanced — một builder và reviewer",
  parallel: "Parallel — yêu cầu browser capacity cao hơn",
  enroll: "Đăng ký Zam agents còn thiếu bằng các template mặc định",
  preview: "Xem trước thay đổi",
  apply: "Áp dụng bản xem trước",
  restart: "Hãy mở session Codex mới để cấu hình có hiệu lực.",
  pending: "Có transaction cần khôi phục. Tạm khóa Apply để tránh ghi đè.",
  recover: "Khôi phục thay đổi chưa hoàn tất",
  noAgents: "Không tìm thấy Zam agent đã đăng ký trong hồ sơ Codex này.",
  noChanges: "Không có file nào cần thay đổi.",
  stale: "Bản xem trước đã hết hạn do cấu hình thay đổi. Hãy tải và xem lại.",
};

export function AgentManagerPanel({ api, language = "en" }: { api: AgentManagerApi; language?: string }) {
  const copy = language === "vi" ? vi : en;
  const [inspection, setInspection] = useState<AgentManagerInspection | null>(null);
  const [preset, setPreset] = useState<"balanced" | "parallel">("balanced");
  const [maxConcurrentThreads, setMaxConcurrentThreads] = useState(4);
  const [enrollMissingRoles, setEnrollMissingRoles] = useState(false);
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
      setMaxConcurrentThreads(next.maxConcurrentThreads ?? 4);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void refresh(); }, [api]);

  const createPreview = async () => {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      if (!Number.isInteger(maxConcurrentThreads) || maxConcurrentThreads < 1 || maxConcurrentThreads > 8) {
        throw new Error("Concurrent threads must be an integer from 1 to 8");
      }
      setPreview(await api.preview({ preset, maxConcurrentThreads, enrollMissingRoles }));
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
    <section aria-label={copy.title} className="settings-list" style={{ marginTop: 24 }}>
      <h2>{copy.title}</h2>
      <p>{copy.intro}</p>
      <div className="manual-turn-actions">
        <button disabled={busy} onClick={() => void refresh()} type="button">{copy.reload}</button>
      </div>
      {inspection && <>
        <p><strong>{copy.current}</strong> — <code>{inspection.codexHome}</code></p>
        {inspection.roles.length === 0 ? <p>{copy.noAgents}</p> : (
          <div>
            {inspection.roles.map((role) => (
              <div className="diagnostic-row" key={`${role.scope}:${role.name}`}>
                <div>
                  <strong>{role.name}</strong>
                  <small>{copy.model}: {role.model} · {copy.effort}: {role.reasoningEffort ?? "—"}</small>
                  <small>{copy.status}: {role.status} · {role.managed ? copy.managed : copy.unmanaged}</small>
                  <small><code>{role.configPath}</code></small>
                </div>
              </div>
            ))}
          </div>
        )}
        {inspection.warnings.map((warning, i) => <p key={i} role="status">{warning}</p>)}
        {inspection.pendingRecovery && <>
          <p role="alert">{copy.pending}</p>
          <button disabled={busy} onClick={() => void recover()} type="button">{copy.recover}</button>
        </>}
        <label style={{ display: "block", marginTop: 12 }}>
          {copy.preset}
          <select disabled={busy} value={preset} onChange={(event) => { setPreset(event.target.value as typeof preset); setPreview(null); }}>
            <option value="balanced">{copy.balanced}</option>
            <option value="parallel">{copy.parallel}</option>
          </select>
        </label>
        <label style={{ display: "block", marginTop: 12 }}>
          {copy.threads}
          <input disabled={busy} type="number" min={1} max={8} step={1} value={maxConcurrentThreads}
            onChange={(event) => { setMaxConcurrentThreads(Number(event.target.value)); setPreview(null); }} />
        </label>
        <label style={{ display: "block", marginTop: 12 }}>
          <input type="checkbox" checked={enrollMissingRoles} disabled={busy}
            onChange={(event) => { setEnrollMissingRoles(event.target.checked); setPreview(null); }} />
          {copy.enroll}
        </label>
        <div className="manual-turn-actions" style={{ marginTop: 12 }}>
          <button disabled={busy || inspection.pendingRecovery} onClick={() => void createPreview()} type="button">{copy.preview}</button>
        </div>
      </>}
      {preview && <div aria-label={copy.preview}>
        {preview.warnings.map((warning, i) => <p key={i} role="status">{warning}</p>)}
        {preview.changes.length === 0 ? <p>{copy.noChanges}</p> : preview.changes.map((item) => (
          <details key={item.path} open>
            <summary><code>{item.path}</code></summary>
            <p>{item.operation}: {item.changedKeys.join(", ")}</p>
          </details>
        ))}
        <div className="manual-turn-actions">
          <button disabled={busy || inspection?.pendingRecovery === true || preview.changes.length === 0}
            onClick={() => void apply()} type="button">{copy.apply}</button>
        </div>
      </div>}
      {restart && <p role="status">{copy.restart}</p>}
      {error && <p role="alert">{error.includes("stale") ? copy.stale : error}</p>}
    </section>
  );
}
