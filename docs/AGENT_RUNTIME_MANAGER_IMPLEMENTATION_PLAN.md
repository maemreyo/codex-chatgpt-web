# Kế hoạch triển khai Agents & Runtime trong Zam Codex Web

Ngày lập: 2026-10-08. Trạng thái: **M1–M4 implemented in RC; live gates for M5–M8 pending**. See `AGENT_RUNTIME_ACCEPTANCE.md` for evidence and limitations. The remaining milestones below are design requirements, not claims that every feature already exists.

Baseline kế hoạch ban đầu: `5893e12` (feature Semantic Epoch Memory). Branch PR chính thức được tạo trực tiếp từ `maemreyo/codex-chatgpt-web:main` tại `b6ca2d3`; các changeset Semantic Epoch Memory và native quota nằm ngoài phạm vi PR. Runtime phiên bản RC là `6.1.8-rc.1`.

## 1. Kết quả cần đạt

Người dùng quản lý browser concurrency, agent và workflow từ Zam Codex Web, xem được cấu hình hiệu lực, chỉnh một lần và dùng cùng cấu hình trong Codex app/CLI.

Định nghĩa hoàn thành:

- Chọn được giới hạn browser session nguyên từ **5 đến 8**, lưu qua restart và được Launcher/daemon/worker/helper/session registry áp dụng thống nhất.
- Nhập và quản lý bốn agent đang dùng; thấy model, effort, instructions, nguồn cấu hình, trạng thái đồng bộ và phạm vi quyền hiệu lực đã xác minh.
- Apply có diff, validation, ownership, phát hiện sửa tay, journal và recovery. Nâng cấp app giữ customization; uninstall không làm mất chỉnh sửa mới hơn.
- Có preset agent-driven sử dụng bốn vai trò, policy không fallback sang model mất phí, phân công file rõ ràng và review có evidence.
- Hoàn thành acceptance bằng Codex/ChatGPT thật cho từng role, workflow và các mức concurrency; local test được báo riêng với live acceptance.
- Có installer mới từ các commit đúng phạm vi và hướng dẫn cài/rollback.

## 2. Phạm vi và các quyết định cố định

### 2.1 Phạm vi bản đầu tiên

Browser capacity 5–8; capacity snapshot và lỗi admission có cấu trúc; native agent manager; bốn role; canonical thread setting; delegation policy; import/diff/apply/recovery; UI Settings/Agents & Runtime; compatibility kiểm tra theo phiên bản Codex; preset và nghiệm thu thực tế.

App quản lý cấu hình và trạng thái tích hợp. Codex giữ vai trò thực thi/điều phối. Không tạo thêm orchestration engine thay thế Codex.

### 2.2 Những phần có giai đoạn riêng

- Queue có xét dependency và fairness: chỉ bật sau khi qua gate chống deadlock.
- Advanced settings: thời gian giữ chat idle, stall handling, MCP/skills, diagnostic storage budget và chế độ nested delegation.
- Role QA/browser tester, thêm model ngoài whitelist và nhiều builder đồng thời: mở rộng sau khi bốn role đầu tiên đạt acceptance.
- Semantic Memory/Web compactor có kế hoạch và changeset riêng; không mặc nhiên đưa vào preset ổn định của kế hoạch này.

### 2.3 Default và preset

| Preset | Browser capacity | Open child threads / root | Hành vi |
|---|---:|---:|---|
| Current | Giữ giá trị hiện có; legacy thiếu field dùng 5 | Giữ setting hiện có | Import không đổi hành vi |
| Balanced | 6 | 4 | Root điều phối, một builder, reviewer cho code |
| Parallel | 8 | 6 | Chỉ bật sau acceptance mức 8 |

Mức browser 5 gợi ý tối đa 3 child threads để chừa một slot cho root và một slot vận hành trong workload một root. Các con số không đảm bảo capacity nếu có nhiều root hoặc profile khác đang dùng chung tài khoản.

Giữ Bigger Context theo lựa chọn đang lưu; fresh eligible profiles tuân theo default của implementation hiện tại. Không tự đổi saved chats, auto-approve tools hay fresh conversation per turn khi import. Preset phải liệt kê mọi thay đổi nó sẽ áp dụng.

Model bốn role giữ `chatgpt-web/gpt-6-sol`. Mọi model khác phải có policy explicit và acceptance riêng; không silent fallback native/API.

## 3. Kiến trúc và ownership

### 3.1 Nguồn dữ liệu

| Dữ liệu | Nguồn thực thi | Trách nhiệm app |
|---|---|---|
| Browser capacity/runtime settings | Runtime config hiện tại của production/DEV | Validate, persist, truyền cùng revision xuống process |
| Global/project agent configuration | Native Codex config và role files | Import, sửa field có ownership, đọc hiệu lực theo cwd/profile |
| Shared role template/policy | Template versioned trong source app | Render native role instructions có marker/version |
| Model routes và effort hợp lệ | Catalog bridge + cấu hình runtime đang hoạt động | Hiển thị route supported; kiểm tra whitelist trước Apply |
| Ownership và recovery | Manifest/journal riêng trong home profile | Last-applied hash/content, baseline, transaction status |
| Sandbox/MCP quyền hiệu lực | Phiên/runtime Codex; tool registry | Hiển thị kết quả xác minh; nếu chưa biết thì ghi chưa xác minh |

Manifest không trở thành bản cấu hình thực thi thứ hai. Trong native files, cấu hình người dùng vẫn đọc/sửa được bằng Codex và editor thông thường.

Template không chứa absolute path của máy maintainer. Path/hook command được render theo Codex home, launcher profile và packaged runtime thực tế; không yêu cầu Python cho người dùng app.

### 3.2 Schema cần bổ sung

- `maxBrowserSessions`: integer 5–8, legacy default 5, canonical field runtime. Launcher state chỉ phản ánh effective/pending value; không có một default cạnh tranh.
- `capacityRevision`: định danh cấu hình có giới hạn độ dài; giúp phát hiện process đang giữ cấu hình cũ, không dùng làm token authorization.
- `AgentManagerManifest`: schema version, profile, selected Codex home, template version, adopted files/fields, baseline snapshot, last-applied digest và transaction reference.
- `AgentConfigSnapshot`: name, scope, path, model, effort, instructions, default permissions, verified effective permissions, inherited overrides, enabled state, native registration và policy status.
- `AgentWorkflowSettings`: delegation mode, canonical child-thread limit, root-only/nested policy, reviewer policy, builder ownership mode và shared retry version.
- `ConfigPreview`: expected input hashes, scoped edits, files affected, compatibility results, hook trust impact, activation timing và recovery record.
- `CapacitySnapshot`: effective max, active physical turns, idle retained tabs, initializing/releasing leases, pending setting; phân biệt các bộ đếm để không double-count.

Chốt schema ở M0. Không đóng băng JSON version/key mới trước khi đánh giá đường migration và reader compatibility.

### 3.3 Apply transaction

1. Read cấu hình native và effective layer đúng cwd/profile; tạo preview bound với input hashes.
2. Validate TOML, duplicate role, path resolution, supported keys, model/effort, policy và capability runtime.
3. Acquire app-managed configuration lock. Kiểm tra lại hash ngay trước ghi; lock không ngăn editor ngoài app nên vẫn cần optimistic conflict checks.
4. Ghi private recovery journal và snapshots cho tất cả participant, giữ permissions cần thiết; preview/log chỉ chứa nội dung đã lọc phù hợp.
5. Render edits có phạm vi; preserve unknown keys, comments và phần instruction cá nhân. Reject trường hợp không có cách patch an toàn.
6. Ghi bằng temp-file/atomic rename theo từng file, đánh dấu tiến độ transaction. Không tuyên bố nhiều file atomic ở cấp OS.
7. Verify native parsing/effective read và policy. Không chạy model inference để validate schema.
8. Commit ownership manifest sau verify; nếu thất bại, recover theo journal. Nếu participant đã bị sửa bên ngoài, dừng restore cho participant đó và đưa ra conflict cụ thể.
9. Publish applied/pending activation state. Nếu Codex cần restart/session mới, hiển thị rõ; không giả định phiên cũ đã nhận setting mới.

Template upgrade là một preview transaction mới, không overwrite customization khi app startup. Backup/journal có giới hạn retention rõ ràng và lưu private; không sao chép credential vào report hay artifact chia sẻ.

### 3.4 Các trạng thái UI

`Discovered`, `Imported`, `Managed`, `Externally changed`, `Unsupported`, `Pending activation`, `Recovery needed`.

Agent hiện có chưa Adopt vẫn xem được. Import chỉ đọc/tạo preview; Adopt/Apply mới xác lập ownership. Disable role phải cập nhật registration, discovery và whitelist cùng phạm vi để không còn đường spawn được role đã disable; không đơn thuần ẩn card UI.

Project overrides hiển thị theo effective layer và giữ quyền ưu tiên native. Bản đầu quản lý personal/global agents; project scope được inspect và giải thích override. Ghi project config nằm trong M7 với transaction scope riêng, không tự thay AGENTS.md các repository.

## 4. Concurrency và admission

### 4.1 Hợp đồng

- Các cap áp dụng cho browser task surfaces/turns; home/login surface không dùng để quảng cáo số task slots.
- Registry và worker giới hạn active turns; BrowserHost có cả active và idle retained tabs. Thu hồi idle đúng lease trước admission, không hủy active để lấy chỗ.
- Admission giữ slot trước các bước async tạo browser document và chỉ release khi cleanup vật lý hoàn tất. Lỗi bootstrap/abort không rò slot.
- Một trace/lease được nhận đúng một lần; duplicate/reconnect không tăng bộ đếm lần hai.
- Root đợi child có thể vẫn giữ browser slot. Child-thread cap native giới hạn thread đang mở, không tương đương số browser lượt đang chạy.
- Capacity mismatch giữa daemon/helper/Launcher phải có trạng thái explicit. Không chấp nhận UI báo 8 trong khi helper/registry vẫn chặn ở 5.

### 4.2 Thay đổi setting

V1 dùng activation tại idle để tránh restart/cancel các lượt đang chạy. Người dùng chọn 8 trong lúc có việc: lưu pending, hiển thị effective value hiện tại. Khi active work đã kết thúc, áp dụng qua runtime operation lock và verify toàn chain.

Giảm cap cần thu hồi đủ idle tabs, không chỉ evict một tab rồi vẫn tạo vượt cap. Nếu còn active hoặc lease đang release, tiếp tục pending. Rollback khi một process không nạp cùng revision. Restart app giữ effective và pending state nhất quán.

Missing field của legacy config vẫn là 5. Với component cũ không hiểu capacity setting, capability check phải giữ cap 5 hoặc yêu cầu cập nhật component; không hạ cap im lặng rồi báo successful Apply.

### 4.3 Admission v1 và queue giai đoạn sau

V1 trả lỗi typed capacity exhaustion kèm max/active và hướng dẫn giảm fan-out hoặc đóng child thread đã xong. Phân loại riêng với ChatGPT account rate limit; không auto-retry browser submission đã được nhận. Chốt HTTP/SSE mapping trước implementation; tránh tạo retry loop của native Codex.

Queue chỉ đi tiếp nếu có metadata lineage tin cậy, lifecycle cancellation và cơ chế progress khi ancestor giữ slot. FIFO đơn thuần không đủ. Nếu không chứng minh được progress, giữ explicit admission và không phát hành queue.

## 5. Cấu hình và workflow agent

### 5.1 Bốn role

| Role | Effort ứng viên | Default sandbox ứng viên | Acceptance của role |
|---|---|---|---|
| Explorer | medium | read-only | Đúng repo/branch, execution path, file:line, contract/test và unknowns |
| Researcher | medium | read-only | Primary sources, applicability/version, facts/inference và quyết định |
| Builder | high | workspace-write | Scope/file ownership, diff, targeted verification và unverified live dimensions |
| Reviewer | high | read-only | Findings P0–P3 có trigger/impact/evidence; kết luận theo acceptance criteria |

Explorer medium được benchmark so với high trước khi đổi default đang dùng. Giữ high nếu evidence không đủ hoặc medium giảm chất lượng.

Không quảng cáo sandbox mặc định là quyền enforced nếu parent chọn full access/yolo. MCP/app tool là surface riêng; kiểm tra quyền hiệu lực của shell và external tools tách biệt. Builder workspace-write phải được thử với build/test thực tế cần cache/temp; không đổi thành full access chỉ để che lỗi setup.

Root-only workflow dùng layer dedicated agent `agents.enabled=false` và instructions không tự delegate; cần live probe. Compatibility V1 hiện nâng `max_depth` lên ít nhất 2: không dùng global depth=1 như một bảo đảm root-only cho bản đầu. Nếu cần hard root-only gate, thực thi theo lineage/context native xác minh được; nếu chưa enforce được, UI ghi policy-only và giữ trạng thái acceptance chưa đạt.

Whitelist phải đọc role hiệu lực và route đúng home/profile. Preserve no-paid-model policy, cấm caller overrides và roles ngoài danh sách; hook chạy bằng packaged runtime. Trust phải xác minh từ Codex, không chuyển hash trusted của hook cũ sang command/code mới bằng giả định.

### 5.2 Hợp đồng giao việc

Root giao goal, checkout/branch, allowed files, acceptance criteria, dependencies và validation budget. Agent trả result, evidence, changes/commands khi có, unresolved questions và NOT_RUN dimensions. Specialist không tự mở rộng phạm vi, commit/push/deploy hay gửi message ngoài authorization của user.

Retry policy chung được template hóa và render vào role files: 3 attempts tổng, cách 3–5s, kiểm tra actual state trước side effects, narrow lần ba, không xin lại approval chỉ vì classifier error.

Reviewer đọc diff/evidence; các test ghi cache/output do builder/root chạy. Khi thêm tester role sau này phải định nghĩa artifact ownership và whitelist riêng.

### 5.3 Workflow ban đầu

1. Root phân tích goal và chia việc độc lập; không delegate việc nhỏ chỉ để lấp slots.
2. Explorer và Researcher chạy song song khi cả hai có việc hữu ích.
3. Root tổng hợp contract và giao Builder một change có scope rõ.
4. Builder đưa diff cùng verification evidence; root giữ trách nhiệm integration.
5. Reviewer xem diff độc lập; finding nghiêm trọng được Builder sửa rồi review phần thay đổi liên quan.
6. Root đối chiếu acceptance, đóng agents không còn dùng và báo kết quả thật.

“Reviewer required” có hai mức: policy của workflow, và gate tại một action app quản lý được. Codex vẫn cho người dùng thao tác thủ công ngoài workflow; app không được hứa khóa mọi commit/deploy toàn máy. Bản đầu ghi đúng mức policy enforcement thực tế.

## 6. Các milestone và gate

### M0 — Chốt contract và baseline

Deliverables: scope/authority snapshot; schema/defaults; native capability probes; independent architecture review nếu tool delegation khả dụng; risk decisions.

- Kiểm tra lại HEAD, worktree/dirty files và source/runtime đang cài. Dùng checkout/worktree riêng cho changeset khi implement; không stash/reset SEM của công việc khác.
- Đối chiếu native quota guard đang xuất hiện trong working tree: preserve API/settings của changeset đó, không tự commit hoặc đưa vào installer của kế hoạch này trước khi xác định revision được nghiệm thu. Quota reserve của native Responses khác browser concurrency và khác whitelist no-paid-delegation.
- Kiểm tra CLI đang dùng, canonical key/alias, role layer inheritance, effective permissions và hook trust; model policy vẫn Web-only đúng whitelist.
- Reviewer rà admission/deadlock, multi-file crash recovery, external edits, project overrides và sandbox claims.
- Nếu chưa có tool delegate phù hợp, ghi independent review NOT_RUN; dùng local audit để tiếp tục preparation, không gọi đó là independent PASS.

Gate: không còn quyết định P0/P1 chưa xử lý về overwrite user config, sai scope hay runtime capacity. Chưa thay cấu hình đang dùng ở bước planning.

### M1 — Session 5–8 xuyên runtime

Files dự kiến: `src/config.ts`, `src/types.ts`, `src/setup.ts`, `src/cli.ts`, `src/launcher-browser-host.ts`, `src/server.ts`, `src/adapters/chatgpt-web/concurrency.ts`, `browser-worker.ts`, `turn-execution.ts`, `launcher-helper-client.ts`, `browser-helper-main.ts`; `launcher/electron/browser-host.cjs`, `control-server.cjs`, `runtime.cjs`, `runtime-supervisor.cjs`, `state.cjs`, `main.cjs`, `preload.cjs`; launcher types/UI/i18n.

- Shared validator/protocol constants có một nguồn build-compatible cho Bun và Electron CJS.
- Persist `maxBrowserSessions`; propagate qua provider config, singleton session registry và process boundaries; handshake capability/revision phù hợp descriptor version đang dùng.
- Pending/idle activation; lỗi typed exhaustion; capacity snapshot; lifecycle reservation/release.
- Settings chọn 5/6/7/8, effective/pending display và dynamic tooltip; tất cả locale hiện có được cập nhật.

Tests: legacy default 5; invalid 4/9/fraction/string; N lượt song song và N+1 overflow; initialization race; close/cancel/abort/bootstrap failure; idle eviction; cap decrease; config mismatch; production/DEV; manual/automatic; managed Chrome không có Launcher.

Gate: focused runtime/launcher tests và typecheck PASS; có thể dùng 5 như trước mà không đổi lifecycle/connector binding.

### M2 — Config discovery và transaction engine

Modules dự kiến mới: `src/agent-management/{schema,discovery,preview,ownership,transaction,recovery}.ts` hoặc module tương đương được chốt sau M0. Tái dùng snapshot/TOML patch/journal hiện có; không tạo parser regex thứ hai cho TOML tổng quát.

- Discover personal/project/legacy mappings; read effective config qua Codex API khi supported.
- Import/customization detection; preview có input digest; managed scope và adoption.
- Multi-file recovery, conflict status; hook/registration/defaults/role files đi cùng transaction.
- Restore/keep semantics khi disconnect/uninstall; backup metadata có version và retention.
- API/CLI read-only `agents inspect`, preview và verify; Apply chỉ nhận scope và preview còn hợp lệ. Tên command là dự kiến, không quảng cáo đã tồn tại.

Tests: unknown keys/comments; role cùng tên khác scope; mapping/discovery duplicate; relative paths; malformed TOML; changed hash; external edit trong lúc Apply; crash tại mỗi participant; rollback/recovery bị sửa ngoài app; symlink/alias file identity; uninstall sau customization; production/DEV isolation.

Gate: không mất field ngoài ownership; rerun Apply idempotent; recovery không ghi đè sửa tay mới hơn.

### M3 — Templates, policy và native role integration

- Đóng gói bốn template và common rules; nhập preset drafts đã chuẩn bị, không copy absolute paths.
- Canonical child-thread limit, role defaults và delegation settings vào native config có ownership.
- Hook whitelist portable trên packaged Bun; verify selected profile/effective role/model. Hook và config được preview/apply cùng transaction.
- Enabling/disabling role và root-only probe; unsupported capability hiển thị rõ.
- MCP/skills policy ban đầu import-preserve; chỉ cắt/allow-list sau khi registry và inheritance được thử.

Tests: whitelist allow/deny, model/effort override, role disabled, model unsupported, selected home khác, customized template upgrade, configured default khác effective permission. Schema parsing riêng với live spawn.

Gate: native config/read và hook listing đúng; tồn tại đường rollback sang các agent đang dùng hiện tại; không tạo paid inference khi verify cấu hình.

### M4 — UI Agents & Runtime

- Runtime capacity selector, native child-thread setting và preset summary.
- Agent list/detail editor: role, model/effort, instructions, default/effective permissions, status/source.
- Import → edit → preview diff → Apply → verification → activation/session mới nếu cần.
- Phát hiện drift khi mở Settings và trước Apply; offer import/merge trong phạm vi cụ thể.
- Recovery view; restore version đã quản lý; export/import bundle không chứa credentials/machine-specific trust.
- Tái dùng setting đã có; không thêm lựa chọn “8” chỉ ở renderer.

Tests: IPC/preload validation; invalid input; pending apply; stale preview; unsupported Codex; drift/recovery rendering. Thử UI thực tế tại 5 và 8 tab, narrow window, keyboard và các locale. Không dùng standalone mock HTML thay app để gọi acceptance.

Gate: một lần chỉnh trong app tạo native config đúng và app/CLI đọc thống nhất; UI phân biệt saved/effective/pending/unknown.

### M5 — Workflow agent-driven và acceptance role

- Root instructions/preset có contract giao việc, giới hạn fan-out, một builder và independent review.
- Live spawn từng bốn dedicated role; không truyền model/reasoning override hay full-history fork trái contract specialized agent.
- Kiểm tra model/effort thực tế, inheritance, scope, terminal wait, closure và không child spawn ngoài policy.
- Workflow một thay đổi nhỏ ở test checkout: explorer/researcher evidence → builder diff/test → reviewer findings → root acceptance.
- Benchmark Explorer medium/high trên cùng bộ tác vụ vừa đủ để đánh giá correctness và latency.

Gate: cả bốn role đúng đường Web; không unauthorized model fallback; hoàn thành workflow không có overlapping writes; quyền read-only chỉ đánh dấu enforced khi đã thử đủ surface. Gaps explicit thì chưa promotion preset đó.

### M6 — Admission nhiều root và queue có dependency

Đầu tiên chứng minh progress với admission v1 ở workloads nhiều root. Queue là feature riêng, mặc định off cho đến khi gate PASS.

- Xác minh lineage nguồn native; không dùng trường do model tự khai làm authority.
- Define queue/admission lifecycle, bounded waiters, cancellation, reservation và fairness giữa root; tránh hold MCP shared channel khi chờ slot.
- Không thu hồi active chat hay resend accepted prompt để tạo progress.
- Nếu ancestor chiếm capacity làm children không thể tiến triển, có cơ chế reject/replan explicit; không giữ vô hạn trong queue.

Tests: nhiều root giữ hết slot rồi spawn; chain parent-child-grandchild nếu nested enabled; canceled waiter; interrupted ancestor; out-of-order result; helper crash; closing UI tab; restart/drain; aging/fairness; saturation không vượt cap.

Gate: stress model chứng minh progress/cleanup; live 6/8 phù hợp; không đạt thì phát hành explicit admission và giữ queue off với trạng thái thực tế.

### M7 — Advanced settings và project scopes

Mỗi tùy chọn chỉ hiển thị khi implementation truyền và kiểm tra được toàn đường runtime:

| Tùy chọn | Kết quả cần nghiệm thu |
|---|---|
| Retained chat idle TTL | 10/30/60 phút; không expire active; resume cùng lease còn hợp lệ |
| Stall handling | Biết ChatGPT đang chạy/tool/approval/suspended; không timeout oan vì thiếu DOM progress |
| MCP/skills từng role | Registry actual, merge inheritance đúng, required tools còn dùng được; effective policy test |
| Nested delegation | Depth + role policy + capacity được đồng bộ; V1 setup không âm thầm đổi ý người dùng |
| Multiple builders | File ownership không chồng hoặc worktree riêng; integration/review rõ |
| Diagnostic storage budget | Bounded values, retention/rotation tested; không raw prompt/credential |
| Shared retry policy | Một template version; preserve user rule và attempts total; state-aware side effects |
| Project agent write | Chọn scope explicit; giữ override precedence và recovery scope project |

Transport poll interval, capability/token TTL, completion fences và physical message ceiling giữ là implementation contracts, không expose thành sliders. Chưa có acceptance thì UI không cung cấp setting với lời hứa chưa enforce.

Gate: từng feature có targeted tests và live check tương ứng. Có thể phát hành M1–M5 trước; ghi rõ advanced features nào chưa giao, không gọi toàn roadmap đã hoàn tất.

### M8 — Build, upgrade và bàn giao

- Independent final review diff và acceptance evidence. Scope commit excludes SEM/unrelated dirty work.
- Chốt version mới sau khi kiểm tra manifest/tag; không dựa vào cùng tên file để phân biệt build cũ/mới. Version source/runtime/launcher đồng bộ.
- Commit theo các mốc coherent đã được human-authorized; không tự push/publish tag hay cài đè app đang chạy nếu scope chưa bao gồm hành động đó.
- Build từ clean intended revision bằng Bun version packageManager yêu cầu; ARM64 trước trên máy hiện tại, matching-OS build cho Windows/Linux.
- Packaged signature/runtime-bundle verification và packaged smoke; kiểm tra native hook hoạt động với packaged Bun không cần Python.
- Upgrade test giữ browser profile, connector, route, agent customization, manifest và pending settings; rollback bản cũ không làm hỏng native config.
- Ghi SHA256, commit/version/platform và evidence file; mở đúng DMG mới cho người dùng cài.

Gate: local/build PASS; live acceptance có từng mức tested; chỉ claim nền tảng đã thử. Release công khai cần các gate trong `docs/release-validation.md`, không thay bằng packaging smoke.

## 7. Ma trận acceptance tối thiểu

| Nhóm | Local/simulated | Live bắt buộc trước promotion |
|---|---|---|
| Session 5–8 | N/N+1, race, release, mismatch, pending decrease | 5, 6, 8 lượt có overlap thực tế; cancel/close và tiếp tục dùng được |
| Native config | canonical aliases, layered fields, migration | app/CLI đọc cùng role/model và phiên mới nhận thay đổi |
| Role policy | parse, whitelist, disabled roles, template diff | spawn bốn role, quyền/default override và tool surface |
| Workflow | scopes/evidence contract fixtures | thay đổi nhỏ hoàn tất builder → reviewer → root |
| Recovery | fault injection mọi file-write boundary | đóng/mở app sau transaction dở; customization vẫn nguyên |
| Queue | dependency/progress/cancel/fairness model | nhiều root saturated không deadlock, không orphan turn |
| Upgrade | manifest migration, hash/runtime smoke | thay phiên bản giữ user config và route; rollback có evidence |

Các phép thử concurrency dùng payload ngắn và công việc hữu ích; không load-test tràn tài khoản. Có terminal usage/rate-limit signal thì ghi riêng account constraint và kết quả NOT_PASSED, không tự tăng concurrency để retry.

Evidence tối thiểu: revision/version, OS, Codex build, preset/profile, effective cap, số child threads, trace correlation không nhạy cảm, result, elapsed time, failure classification và cleanup. Thông báo agent nói “đã retry” không thay cho lifecycle evidence.

## 8. Thứ tự làm và commit dự kiến

1. M0 → M1: `feat: configure ChatGPT Web browser capacity`.
2. M2: `feat: import and transact native Codex agent configuration`.
3. M3: `feat: package Zam agent templates and delegation policy`.
4. M4: `feat: manage agents and runtime settings in launcher`.
5. M5: `feat: add verified agent-driven workflow presets` và acceptance evidence phù hợp.
6. M6: changeset queue riêng, chỉ enabled sau gate.
7. M7: từng nhóm advanced settings/project scope có commit riêng.
8. M8: version/build/docs/evidence release theo phạm vi được giao.

Tên commit là dự kiến, có thể tách dependency plumbing khỏi UI để reviewer kiểm tra dễ hơn. Không lấy số milestone/commit thay cho chứng minh behavior.

## 9. Điều kiện dừng và rollback

- Có nguy cơ overwrite config ngoài ownership: dừng Apply, giữ preview/conflict và baseline; không repair bằng ghi đè cả file.
- Model/route/hook verification sai: không promotion preset, restore phần transaction còn sở hữu; không chạy model khác.
- Quyền inherited khác preset: hiển thị actual/unknown, không đổi quyền cha âm thầm.
- Capacity mismatch hay slot leak: giữ cap cũ hoặc pending; rollback settings transaction sau khi idle, không cắt active turn.
- Queue không progress: disable queue và giữ typed admission; không replay accepted request.
- Build/local PASS nhưng live chưa chạy: giữ candidate, ghi live NOT_RUN; không claim stable acceptance.
- Safety classifier transient: tuân theo rule user đã giao, tối đa 3 attempts tổng, state check trước retry side effects. Không xin lại permission chỉ vì lỗi đó.

## 10. Tài liệu và preset đầu vào

- Research: bản thiết kế nghiên cứu nội bộ, không đóng gói đường dẫn cá nhân vào bản phân phối.
- Candidate roles: cùng thư mục, `presets/zam-{explorer,researcher,builder,reviewer}.toml`.
- Verification: `verification.json`, bốn bộ field strict-config PASS, hai thread-limit aliases PASS, bảy local whitelist cases PASS. Live spawn/8-browser-turn test vẫn NOT_RUN ở thời điểm lập plan.
- [Official Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) và [Config Reference](https://learn.chatgpt.com/docs/config-file/config-reference) dùng để đối chiếu; capability của installed binary mới là evidence cho activation trên máy người dùng.

Kế hoạch hoàn tất khi các phần được phát hành có evidence tương ứng và trạng thái phần chưa giao rõ ràng. Hiện tại chỉ tài liệu plan/preset đã được tạo; không thay agent hay runtime đang chạy.
