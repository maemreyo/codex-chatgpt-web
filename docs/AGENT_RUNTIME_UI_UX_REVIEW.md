# Agents & Runtime — UI/UX review (2026-10-08)

Scope: Settings → Agents & Runtime in the existing Electron launcher, with no changes to native authorization, ChatGPT submissions, account sessions, or the transactional Preview/Apply contract.

## Problem observed

- The owner selected Balanced, but the setting was not applied; the native Codex config still specified 6 child threads. A dropdown selection looked final even though it was only a draft.
- The prior panel showed the four long agent rows before the preset; saving required scrolling to controls at the bottom.
- A configured browser capacity of 8 could coexist with an effective limit of 5 until restart, and the panel did not distinguish those values beside the preset.
- An existing nonstandard native child-thread count could appear under the Balanced label despite not being 4.

## Design references

- Nielsen Norman Group, [Visibility of system status](https://www.nngroup.com/articles/visibility-system-status/): provide immediate, clear feedback for settings and changes.
- GOV.UK Design System, [Radios](https://design-system.service.gov.uk/components/radios/): represent mutually exclusive options with concise supporting hints.
- DWP Design System, [Hint text](https://design-system.dwp.gov.uk/guidance/hint-text): essential state must be directly visible, rather than hidden in optional explanations.
- W3C, [WCAG 2.2 status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html): announce status updates without moving keyboard focus.
- GOV.UK Design System, [Error messages](https://design-system.service.gov.uk/components/error-message/): show errors near inputs and retain entered values for correction.

## Implemented

1. Put workflow settings above agent-role editing. Provide two full-width/selectable Balanced and Parallel preset cards, each showing thread count and suggested browser capacity; allow a Custom native limit without mislabelling it.
2. Display saved native thread count, explicit Unsaved changes / All changes saved feedback, and a persistent Review/Apply action bar only while changes are pending. Discard changes restores the inspected native values without writing to the Codex profile.
3. Preserve transactional Preview → Apply. Preset cards update the local draft; applying is explicit. The saved preset is inferred from the actual inspected Codex thread limit on mount, Refresh, Apply, and recovery.
4. Distinguish configured browser capacity from effective runtime capacity and provide an explicit restart explanation if they differ. Browser capacity stays a separate setting from native agent limits.
5. Show actionable inline child-thread validation for the 1–8 supported range; preserve keyboard-accessible radio controls, fieldset grouping, focus styling and a live save-status announcement.
6. Keep each role's advanced editor collapsed until requested. Render mock and real profile paths only within the relevant role/metadata context.
7. Expand Settings beyond the previous narrow single-column width. Present Agents & Runtime, General, Configuration, Diagnostics and product information as dashboard cards, with Agents & Runtime first and spanning two columns where space permits. Place agent roles in a two-by-two grid on wide windows instead of a long list. Layout responds to the available settings content width: one column below 760px, two at 760px, and three at 1220px; the runtime card stays two columns wide in the multi-column layouts.

## Validation and remaining gate

- Source typecheck, localized dictionaries, focused agent-manager and renderer regression tests, renderer build, and diff whitespace checks must pass.
- Isolated, fake-API browser QA covers selection of Balanced from a persisted Parallel (6), draft status, Review → Apply, and persistence after inspection; check 1060px and 480px widths for overflow. This does not read or write the real user profile.
- Full Settings dashboard visual QA **PASS** with real Chrome rendering against a temporary isolated Vite fixture using fake agent state and stub IPC (never the native user Codex profile). Tested viewport widths 1780, 1240, 1060, 760, 480 and 390: actual dashboard columns 3/2/2/1/1/1; role columns 2/2/2/2/1/1. All six had no document or dashboard horizontal overflow and no browser page errors. Visual screenshots were inspected at desktop and mobile widths, including the bottom of mobile Settings.
- Fake API interaction **PASS**: persisted Parallel (6), select Balanced (4), show Unsaved changes, Preview, Apply, and confirm saved native thread count (4). In the mobile preview, the save bar appears only for a draft and disappears after Discard; at rest it does not obscure settings. Local temporary fixtures and Vite server were removed after QA.
- Authentication-bound capacity N+1, restart/upgrade compatibility, native role spawning, whitelist/hook trust, paid-model routing, and multi-root saturation remain NOT_RUN until explicitly tested with actual account evidence.
- A changed renderer build does not update the currently installed application. Package and reinstall separately after the owner finishes live sessions and approves the release workflow.
