import { useEffect, useState } from "react";
import type { AgentManagerApi, AgentManagerInspection, AgentManagerPreview, AgentRoleEdit } from "./agent-manager-types";

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
  edit: "Edit role settings",
  roleEffort: "Reasoning effort",
  roleSandbox: "Requested sandbox",
  roleInstructions: "Developer instructions",
  keep: "Keep existing",
  permission: "Effective permissions: not verified (Codex may inherit broader access).",
  capacitySuggestion: "Suggested browser capacity for this workflow: {count}. Current setting: {current}. Capacity changes take effect after a launcher restart.",
  setCapacity: "Set suggested browser capacity",
  modified: "Unsaved role edits are included in the next preview.",
  routeWarning: "This role does not use the approved Web route. Confirm the Web route before applying edits.",
  repairRoute: "Use approved ChatGPT Web model",
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
  edit: "Chỉnh cấu hình role",
  roleEffort: "Mức suy luận",
  roleSandbox: "Sandbox yêu cầu",
  roleInstructions: "Developer instructions",
  keep: "Giữ nguyên",
  permission: "Quyền thực tế: chưa xác minh (Codex có thể kế thừa quyền rộng hơn).",
  capacitySuggestion: "Browser capacity gợi ý cho workflow này: {count}. Đang đặt: {current}. Cần khởi động lại Launcher để áp dụng thay đổi.",
  setCapacity: "Đặt browser capacity gợi ý",
  modified: "Các chỉnh sửa role được đưa vào bản xem trước tiếp theo.",
  routeWarning: "Role này chưa dùng Web route được duyệt. Hãy xác nhận Web route trước khi Apply.",
  repairRoute: "Chuyển sang model ChatGPT Web được duyệt",
};

export function AgentManagerPanel({ api, language = "en", browserCapacity, onSetBrowserCapacity }: {
  api: AgentManagerApi;
  language?: string;
  browserCapacity?: number;
  onSetBrowserCapacity?: (value: number) => Promise<void>;
}) {
  const copy = language === "vi" ? vi : en;
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
        throw new Error("Concurrent threads must be an integer from 1 to 8");
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
                {role.configPath !== "—" && <details>
                  <summary>{copy.edit}</summary>
                  <p>{copy.permission}</p>
                  {role.policy !== "web-only" && <>
                    <p role="alert">{copy.routeWarning}</p>
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
                      {copy.repairRoute}
                    </label>
                  </>}
                  <label style={{ display: "block" }}>{copy.roleEffort}
                    <select disabled={busy} value={roleEdits[role.name]?.reasoningEffort ?? ""}
                      onChange={event => editRole(role.name, "reasoningEffort", event.target.value)}>
                      <option value="">{copy.keep} ({role.reasoningEffort ?? "—"})</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                    </select>
                  </label>
                  <label style={{ display: "block" }}>{copy.roleSandbox}
                    <select disabled={busy} value={roleEdits[role.name]?.sandboxMode ?? ""}
                      onChange={event => editRole(role.name, "sandboxMode", event.target.value)}>
                      <option value="">{copy.keep} ({role.sandboxMode ?? "—"})</option>
                      <option value="read-only">read-only</option>
                      {role.name === "zam-builder" && <option value="workspace-write">workspace-write</option>}
                    </select>
                  </label>
                  <label style={{ display: "block" }}>{copy.roleInstructions}
                    <textarea disabled={busy} rows={5} style={{ display: "block", width: "100%" }}
                      value={roleEdits[role.name]?.developerInstructions ?? role.developerInstructions ?? ""}
                      onChange={event => editRole(role.name, "developerInstructions", event.target.value)} />
                  </label>
                  {roleEdits[role.name] && <small>{copy.modified}</small>}
                </details>}
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
          <select disabled={busy} value={preset} onChange={(event) => {
            const next = event.target.value as typeof preset;
            setPreset(next);
            setMaxConcurrentThreads(next === "parallel" ? 6 : 4);
            setPreview(null);
          }}>
            <option value="balanced">{copy.balanced}</option>
            <option value="parallel">{copy.parallel}</option>
          </select>
        </label>
        {browserCapacity !== undefined && <p role="status">
          {copy.capacitySuggestion.replace("{count}", String(suggestedCapacity)).replace("{current}", String(browserCapacity))}
          {browserCapacity !== suggestedCapacity && onSetBrowserCapacity && <button type="button" disabled={busy}
            onClick={() => { void onSetBrowserCapacity(suggestedCapacity).catch(cause => setError(String(cause))); }}>
            {copy.setCapacity}
          </button>}
        </p>}
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
