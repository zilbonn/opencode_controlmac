---
name: control-mac
description: Operate local macOS application or browser UI through ControlMac when a task requires visible clicking, typing, screenshots, dialogs, uploads, or a workflow across apps.
---

# Control Mac

Use the local ControlMac tools to complete visible UI work. Treat tool dispatch as an attempt; success requires observing the requested state afterward.

## Route by surface

- Use `controlmac-browser` (Chrome DevTools) for page content in the normal Google Chrome stable session: tabs, navigation, DOM/accessibility snapshots, fields, page buttons, JavaScript dialogs, page drag-and-drop, uploads, screenshots, and page waits. It connects with `--auto-connect --channel=stable` and requires Chrome stable 144 or newer.
- Before every browser workflow, call `list_pages`, select the intended page, and act only when it returns the expected pages. If auto-connect is unavailable, open `chrome://inspect/#remote-debugging` in normal Chrome, ask the user to enable remote debugging, restart OpenCode, call `list_pages` to trigger Chrome's prompt, let the user accept it, then retry `list_pages`. This is Chrome's built-in local debugging flow and uses no extension.
- Use `controlmac-native` (Peekaboo MCP) for native Accessibility inspection and background-safe semantic actions in apps and browser chrome. It is forced to the stable local runtime with `--no-remote`. Its execution policy is background-only; an `AGENT_EXECUTION_POLICY_REFUSAL` means the requested action requires one of the narrow foreground wrappers below.
- Use `controlmac-capture` only for `see`, `image`, screenshots, annotations, and OCR. It is pinned to the permission-aware Peekaboo app bridge. Do not send mutating tools through this server: Peekaboo 4.2.2 can lose mutation receipts on the GUI bridge.
- For `controlmac-capture image`, use `format: "data"` when OpenCode needs the image inline. For `format: "png"` or `"jpg"`, always provide an absolute `path` and verify that file; never request a file format without a path.
- Snapshot and element IDs are server-scoped. Never pass a `controlmac-capture` snapshot or element ID to `controlmac-native` or a foreground wrapper. Resolve actionable targets with a fresh `controlmac-native inspect_ui`; use capture results only as visual evidence.
- Use `controlmac_app` only for foreground app launch/open/focus/unhide/relaunch/switch. Use `controlmac_window_focus` with the exact numeric PID and window ID, including cross-Space focus; never pass an application name or an MCP snapshot. Use `controlmac_dialog_file` only for native open/save dialog entry. These wrappers intentionally use Peekaboo's default on-demand route rather than the GUI bridge because 4.2.2 can return incomplete foreground target receipts through that bridge. Reinspect after every wrapper call.
- Use `controlmac_drag` only for native shared-cursor drag-and-drop after the exact source window is already focused and freshly inspected. Browser-page drags stay in Chrome DevTools. Do not substitute these wrappers for unrelated policy-refused actions.
- Prefer an available API or CLI when the task is about data rather than visible UI state.

When a workflow crosses surfaces, finish and verify a checkpoint on the current surface before switching. On every switch, reselect and observe the exact app/window or browser page; do not reuse an element reference from the previous surface.

## Control loop

For each user-visible checkpoint:

1. Define the observable postcondition.
2. Observe the exact app and PID, window ID, or browser page ID. Capture the current snapshot and relevant before-state.
3. Resolve one unambiguous target using the priority below.
4. Dispatch one action.
5. Wait only as long as the operation class permits, then observe again.
6. Continue only when the postcondition is visible. Otherwise classify the state and recover.

Keep in task state: active surface, app/PID, window ID or page ID, latest snapshot ID, expected postcondition, attempted targeting routes, and last verified checkpoint.

## Targeting priority

For native UI:

1. Fresh Peekaboo Accessibility element ID from `controlmac-native inspect_ui`.
2. A unique exact role plus identifier, title, or label within an exact window.
3. An Accessibility query that resolves to one element.
4. Coordinates derived from the same fresh window snapshot.
5. Local OCR from `controlmac-capture` as visual evidence, followed by a fresh native inspection before action.
6. A fresh annotated capture interpreted visually, followed by one coordinate action bound to the fresh native snapshot.

For browser-page content:

1. Call `list_pages` on `controlmac-browser` and select the intended page.
2. Fresh DOM/accessibility UID from that browser surface's `take_snapshot`.
3. A semantic browser action bound to the exact page ID.
4. A fresh browser screenshot and one coordinate action.
5. Native Peekaboo only for browser chrome, a native dialog, or observation while CDP is unavailable. Do not cycle native AX click, type, set-value, and paste attempts against Chromium page content.

Never guess among duplicate labels or windows. Narrow by exact PID, window ID, or page ID. If it remains ambiguous, stop and report the candidates.

## Snapshot rules

Peekaboo element IDs and browser UIDs are snapshot-scoped. Track native and capture snapshots separately. Capture IDs are visual evidence only; never use them for actions. Reobserve after any scroll, navigation, app switch, window move or resize, menu or dialog opening, DOM replacement, or failed lookup. Never carry raw coordinates to a new snapshot or assume a fixed Retina scale. Pass the current native snapshot to every native coordinate or drag action; `controlmac_drag` resolves that native snapshot locally before dispatch.

Before replaying a failed action, inspect for a modal dialog, menu, pop-up, changed frontmost window, navigation, loading state, or CDP disconnect. If the state changed but the outcome is unclear, do not replay; inspect until it can be classified.

## Verification

Verify the effect that matters, not the tool return code:

- Launch: the process and requested window exist.
- Click or shortcut: the expected focus, value, menu, dialog, window, or page state appears.
- Type: the target field contains the expected value.
- Scroll: the requested sentinel appears or the scroll state changes.
- Drag: a fresh inspection shows the source or destination changed.
- Upload: the input or application shows the expected filename.
- Navigation: both URL and an expected page element or text match.
- Screenshot: the image has nonzero dimensions and identifies the requested screen or window.

When there is no observable postcondition, report `dispatched_unverified`; do not call it successful. Every `controlmac_*` foreground wrapper returns `needs_reinspection: true` and must be followed by a fresh observation, even when Peekaboo also returned an internal verification receipt.

## Waits, retries, and recovery

- Allow 5 seconds for element lookup or an ordinary action, 15 seconds for launch/navigation/dialogs, and 30 seconds for upload.
- Poll changing UI around every 250 ms and accept it only after the expected state remains stable for about 300 ms. Prefer semantic wait tools over fixed sleeps.
- After a fresh observation, retry a retry-safe semantic action once.
- Then allow at most one fresh coordinate fallback and one fresh OCR/vision fallback.
- Do not automatically retry typing, submission, drag, or any action that may have partially dispatched. Inspect its post-state first.
- A wrapper may return `partial_dispatch: true` with Peekaboo `error`/`outcome` data after a nonzero CLI exit. If `mutation_dispatched` is true, treat the action as attempted, require fresh observation, and do not retry when `retry_safe` is false.
- If Peekaboo reports an incomplete application inventory, do not retry a name selector. Re-list the exact process/window, then use numeric PID plus window ID. `controlmac_window_focus` accepts only those exact selectors.
- Peekaboo 4.2.2 can fail exact Chrome window capture with `Bridge operation target attribution failed` or `Image processing produced no final image bytes`. Do not repeat the same capture. Use the connected browser MCP screenshot; if there is no browser connection, use `controlmac-capture image` for `screen:N` or all screens without an app/window target as visual evidence.
- If a Chromium native mutation reports missing or invalid canonical result semantics, inspect once to learn whether it dispatched. Do not try the same field through click, type, set-value, and paste in sequence. Switch to `controlmac-browser`. If it cannot list the intended pages, stop at its connection setup instead of generating more failed calls.
- Peekaboo 4.2.2 cannot complete `dialog file` against an attached TextEdit Save As sheet because its generic exact-window focus preflight cannot represent that sheet. If a fresh inspection shows the same sheet after a `response_lost`/focus timeout, do not replay or add `--no-auto-focus`. For a same-directory rename, use exact background `dialog input` on the parent window, reinspect the filename, then exact background `dialog click` and verify the file. Changing that sheet to an arbitrary directory remains a blocker in v1.
- On a stale target, reobserve and resolve it again; never retry the stale ID or coordinate.
- On failure, return the current app/window/page identity, fresh screenshot or snapshot, observed state, attempted routes, last verified checkpoint, and the next concrete recovery step.

For a multi-app task, resume from the last verified checkpoint rather than replaying the whole workflow.
