# Review implementation plan — Semantic Epoch Memory

Ngày: 2026-10-07. Đối tượng review: `docs/SEMANTIC_EPOCH_MEMORY_IMPLEMENTATION_PLAN.md`, bản untracked trên branch `feat/semantic-epoch-memory`, code baseline `fdb15fff5620aeac0135097705fea41a31e5abd7`.

**Kết luận: cần sửa thiết kế trước khi triển khai toàn bộ S1–S8 hoặc quảng bá logical context 240k.** Canonical/browser separation và feature default-off là hướng hợp lý, nhưng plan chưa giải quyết đầy đủ workload dài trong một native turn, bảo toàn instructions ở browser, physical occupancy và recovery khi canonical history vượt browser budget. Phần semantic quality còn thiếu acceptance cụ thể.

Đây là review thiết kế dựa trên source local và hai probe local. Semantic runtime chưa được triển khai, nên các findings mô tả hậu quả của thuật toán đề xuất; không phải tuyên bố đã tái hiện lỗi của feature đang chạy. Không thay đổi plan gốc hoặc runtime code.

## R1 — [P1] Checkpoint chỉ ở final answer không xử lý được một native turn dài

**Vị trí plan:** lines 395–407, 429–438; S7 lines 725–729.

Plan yêu cầu hoàn tất native turn rồi mới commit checkpoint và xoay ở `T+1`. Trong Full harness, nhiều Responses tool rounds chạy trong cùng một browser execution. `startRuntime()` chỉ được tạo khi chưa có session tương ứng, thông qua `getOrCreateAfterOwnerRetirement()` (`index.ts:1175`). Tool results tiếp theo được chuyển trực tiếp cho broker/browser execution đang chạy (`index.ts:1263–1283`). Một Responses `done` kèm tool calls không đồng nghĩa browser turn đã hoàn tất.

Ví dụ: một user request “implement và test” tạo nhiều tool results, mỗi result vẫn đủ nhỏ để trả về, nhưng tổng transcript vượt physical budget trước khi có final answer. Plan sẽ chưa có checkpoint được commit, không thể xoay epoch, trong khi native auto-compact đã bị nâng tới khoảng 220k. S7 hiện chỉ chứng minh nhiều turn có thể tích lũy 240k, không chứng minh workload này.

**Sửa cần thiết:** chọn và ghi rõ một trong hai scope:

- V1 chỉ tối ưu lịch sử giữa các native turns; vẫn giữ guard/handoff/compact sớm theo physical pressure trong active turn. Mục tiêu 240k có điều kiện, không áp dụng cho mọi single-turn tool loop.
- Thiết kế thêm cooperative semantic handoff trong cùng native turn: giao tool results exact, kết thúc generation ở ranh giới an toàn, capture checkpoint, retire capability cũ, rồi resume execution mới dưới cùng canonical instruction lineage. Đây là slice riêng cần thay đổi session/runtime contracts, không phải chỉ thêm projector trong `startRuntime()`.

Không xoay browser surface khi tools còn outstanding. Bổ sung acceptance: một user request duy nhất, nhiều tool batches, vượt physical threshold trước final answer, không lặp effect và không mất result.

## R2 — [P1] “Checkpoint + suffix” làm mất developer instructions vẫn hiệu lực

**Vị trí plan:** lines 334–348.

Thuật toán giữ `systemPrompt` nhưng thay toàn bộ messages trước anchor bằng assistant summary. Trong parser, developer messages được giữ ở `context.messages`, không đưa vào `systemPrompt` (`parser.ts:398–405`). Developer instructions xuất hiện trước anchor sẽ biến mất khỏi prompt của epoch mới. Selected skill instructions ở user priority cũng cần policy rõ về hiệu lực sau rotation.

Giữ canonical `_rawBody` chỉ giúp bridge validation; browser model vẫn quyết định hành động từ prompt đã compile. Một câu summary nói “current developer instructions authoritative” không đưa các instructions bị bỏ trở lại và cũng không giữ được priority nếu chúng bị kể lại trong assistant summary.

**Probe local:** canonical request gồm developer `PINNED_DEVELOPER_DO_NOT_PUSH`, user cũ, assistant anchor, user “continue”. Áp dụng đúng công thức checkpoint + messages sau anchor rồi compile bằng compiler hiện tại:

```json
{
  "canonicalDeveloperPresent": true,
  "browserDeveloperPresent": false,
  "rawBodySame": true
}
```

**Sửa cần thiết:** xác định tập instructions còn hiệu lực từ canonical history và giữ nguyên content, role, thứ tự/priority trong browser projection. Semantic summary chỉ thay settled task evidence được phép nén. Thêm tests cho developer trước anchor, selected skill, supersession và instructions có nội dung giống tool output; không suy ra instruction authority từ text của summary.

## R3 — [P1] Fallback và native compact chưa có đường phục hồi an toàn trên history lớn

**Vị trí plan:** lines 364–375, 785–811; rollback lines 833–843.

Khi feature cho phép canonical history khoảng 180–240k, “fallback về canonical” có thể tạo prompt vượt physical budget. Checkpoint hết TTL, mất/corrupt file, mismatch sau restart, bật feature trên thread đã lớn hoặc tắt feature đều có thể đi vào trạng thái này. Default-off tương thích code path không đồng nghĩa thread 180k có thể tiếp tục ngay trên legacy budget.

Plan còn miễn projection cho `_compactionRequest`. Native `/compact` ở logical threshold 220k vì thế có thể nhận canonical input quá lớn. Inline compaction compiler hiện tại cắt oldest messages theo JSON byte budget (`prompt.ts:696–732`), chỉ pin readable native compaction summary. Semantic checkpoint trong file riêng không tự xuất hiện ở đây. Khi source retained conversation không còn khả dụng, compact có thể bỏ phần lịch sử mà semantic checkpoint là bản tóm tắt duy nhất có thể gửi vừa budget.

**Probe local:** compile một native compaction request gồm early fact sentinel và nhiều historical messages:

```json
{
  "isCompaction": true,
  "omittedMessages": 13,
  "earlyFactPresent": false
}
```

Probe xác nhận fallback compaction hiện có là lossy trimming; không chứng minh mọi retained-tab handoff đều mất dữ liệu. Bigger Context cũng là lựa chọn transport riêng, chưa phải fallback bắt buộc hoặc bảo đảm cho mọi mode/account.

**Sửa cần thiết:** bổ sung state machine recovery: checkpoint hợp lệ / checkpoint không dùng được / retained tab còn hoặc mất / canonical dưới hoặc trên physical budget. Native compact phải có browser view phù hợp riêng, có thể dùng semantic checkpoint đã xác minh + exact suffix + instruction compact, trong khi canonical provenance và compact response format không đổi. Khi không còn nguồn memory an toàn, trả lỗi recovery rõ ràng và bảo toàn canonical history; không gửi prompt quá lớn hoặc tự coi oldest-message trimming là bảo toàn memory.

Rollback cần mô tả điều kiện để tiếp tục thread đã lớn: hoàn tất safe native compaction trước khi quay về legacy, hoặc chấp nhận cần recovery. Gate restart/flag-off phải dùng canonical history đã vượt legacy budget.

## R4 — [P1] Physical occupancy không thể suy ra chỉ từ projected prompt

**Vị trí plan:** lines 409–425, 472–479; S5 lines 684–695.

Compiler estimate trên projected history và lượng context đang tồn tại trong retained ChatGPT conversation là hai đại lượng khác nhau. Với reuse, worker chọn `prepareResume` và preflight chỉ kiểm tra message sắp gửi (`browser-worker.ts:4782–4784`, `4802–4863`). Tools trong execution đang chạy được giao trực tiếp qua `broker.completeTool()`; chúng không qua composer preflight. Retained transcript còn có transport wrappers ở mỗi turn, connector formatting, tool calls/results, assistant output và private checkpoint tail đã sinh.

Nếu chỉ estimate “checkpoint + canonical suffix” rồi gọi đó là physical usage, hệ thống có thể đánh giá thấp occupancy và quyết định xoay quá muộn. Ngưỡng 70–80% không bảo vệ được một tool batch làm usage nhảy lớn. Không nên ghi “mọi browser working set đều trong measured limit” nếu chỉ có estimate selected prompt.

**Sửa cần thiết:** tách ít nhất ba số: canonical logical tokens; next wire message tokens/chars/attachments; conservative estimated epoch occupancy. Cập nhật occupancy trên accepted submissions, generated output và tool result delivery, chống double-count khi replay. Gắn guard với live session trước/ở ranh giới giao tool batch, cùng reserve rõ cho output/checkpoint. State không chắc chắn sau restart phải có policy rehydrate/rotate, không mặc định occupancy = 0. Giữ cách gọi “estimated” cho phần không đo được từ browser/provider.

Acceptance cần scenario next prompt rất nhỏ nhưng retained epoch đã lớn, repeated wrappers, tool-result size jump và reconnect không cộng/khử token hai lần.

## R5 — [P2] Hash answer và source user revision chưa bind toàn bộ prefix bị thay

**Vị trí plan:** lines 257–277, 329–333.

Checkpoint có thể chứa kết luận từ nhiều historical turns/tool results, nhưng schema chỉ bind source turn, source answer và source user revision. Hai canonical histories có cùng các trường này nhưng khác earlier tool evidence hoặc earlier instruction vẫn có thể dùng chung checkpoint. `semanticEpoch` là counter, không chứng minh covered history giống nhau.

**Sửa cần thiết:** checkpoint record cần định nghĩa chính xác covered range/cut và fingerprint trên canonical source items của range đó, có namespace/model-policy/schema discriminator khi cần. Không hash parsed timestamps vì parser tạo timestamp theo thời điểm parse. Test: đổi một historical tool result trước anchor, giữ nguyên source answer và source revision, checkpoint phải bị từ chối.

Có thể dùng cumulative digest để giảm chi phí nếu sau này lưu DAG, nhưng cần cùng semantics ở full-input và `previous_response_id` replay.

## R6 — [P2] Acceptance đo dung lượng nhưng chưa đo chất lượng semantic memory

**Vị trí plan:** lines 238–247, 424–425; S7 lines 723–738; acceptance cuối plan.

Summary prompt yêu cầu giữ các facts “khi relevant”, nhưng plan không định nghĩa cách đánh giá relevance hoặc sửa thiếu sót. Giữ raw history trong canonical store không giúp model tự truy cập facts đã bị bỏ khỏi browser view. Runtime có thể đạt 240k, đúng hashes và đúng tool pairing nhưng quên quyết định quan trọng, lặp lại hướng đã thất bại hoặc bịa evidence sau vài lần nén.

**Sửa cần thiết:** bổ sung semantic evaluation gate trước khi nâng catalog window hoặc chấp nhận S7. Bộ workload phải có facts cần dùng muộn, steering/decision supersession, commands/test results mâu thuẫn, unresolved blockers và ít nhất vài epoch liên tiếp. Đánh giá cả thực hiện next action đúng lẫn recall có evidence; so sánh full-context baseline và memory projection. Định nghĩa failure threshold, không chỉ yêu cầu nonempty summary.

Chọn policy rõ cho raw-evidence rehydration: retrieval theo immutable canonical refs, pin facts có nghĩa vụ bảo toàn, hoặc thừa nhận scope memory lossy và cách model trả lời khi evidence không còn trong working set. Hashes chỉ chứng minh binding; không chứng minh summary đúng hoặc đầy đủ.

## Integration points còn cần chốt

- Parser không có mapping 1:1 giữa raw item và parsed message. Reasoning có thể được ghép vào assistant, `additional_tools` không sinh message; parsed messages không giữ native `turn_id`. S3 cần một cách xác định exact cut có provenance, không lấy raw array index để slice parsed messages. Ưu tiên sidecar mapping giữ canonical object nguyên vẹn và test cases cho tool search, reasoning, duplicate assistant text.
- S2 phải mở rộng `BrowserTurn`/private-tail capture trong worker hoặc helper thực tế. `browser-worker.ts:4772–4776` hiện chỉ cho Luna capture; thêm prompt contract và adapter callback chưa đủ. Review wire/stream paths, không chỉ `index.ts`/`prompt.ts`.
- Checkpoint commit cần xảy ra sau native output validation/completion fence và có idempotency theo source identity. Atomic file write không tự chống replay/late completion ghi đè epoch mới. Thêm crash/reconnect/delayed-completion tests.
- Các experimental flags/modes cần compatibility matrix: Bigger Context, Fresh Conversation Per Turn, Skill Attachments, saved/temporary chats, launcher/managed Chrome, read-only/local-tools và model switch. V1 nên có eligibility rõ; config=true không tự chứng minh route đó hỗ trợ semantic rotation.

## Thứ tự sửa plan được đề nghị

1. Chốt scope active-turn handoff hoặc fallback physical guard (R1), cùng occupancy model (R4).
2. Chốt projection contract: pinned authority, exact suffix cut, covered-range fingerprint (R2/R5).
3. Chốt recovery/native compact/rollback state machine (R3).
4. Chốt semantic eval và rehydration policy (R6).
5. Sau đó triển khai store + capture + projector/rotation dưới flag. Nâng logical catalog lên 240k sau khi các gates trên có bằng chứng.
6. Giữ `previous_response_id` v2 là migration riêng. Sparse base snapshots/ancestor pruning cần review riêng khi đến S8.

Không có lý do từ review này để bỏ fork hoặc bỏ canonical/browser separation. Tuy nhiên, chưa nên coi plan hiện tại là một implementation contract đủ để giải quyết tool output của long-running agents.

## Phạm vi kiểm chứng của review

- Đã đọc plan và đối chiếu parser, types, adapter runtime/session creation, tool settlement, worker preflight, usage, checkpoint store, compaction compiler/handoff và response-state cache.
- Đã chạy hai probe bằng `bun run -`: projection mất developer instruction; inline native compaction bỏ early fact sentinel. Cả hai exit 0, output ghi ở findings trên.
- Không chạy lại baseline 154 tests hoặc suite toàn repo: review này không thay runtime.
- Không chạy browser/live account, không chứng minh window 240k, không đo chất lượng summary thực tế.
- Không refresh upstream issues/PRs ở lượt review này; conclusions dựa trên exact local candidate đã ghi đầu tài liệu.
