# OpenCode ControlMac

Local macOS and Chrome control for [OpenCode](https://opencode.ai/), without a browser extension.

```text
OpenCode + control-mac skill
├── controlmac-native MCP         → Peekaboo local runtime → Accessibility / semantic input
├── controlmac-capture MCP        → Peekaboo app bridge → screenshots / OCR / annotated UI
├── controlmac-browser MCP        → Chrome DevTools MCP → normal Chrome stable session
└── controlmac_* tools            → narrow Peekaboo CLI foreground actions
```

ControlMac adds a global OpenCode skill, an idempotent installer, diagnostics, and four foreground wrappers. The skill applies an observe → target → act → verify → recover loop while Peekaboo and Chrome DevTools MCP perform the automation.

## Requirements

- macOS 15 or newer on Apple Silicon.
- [Node.js](https://nodejs.org/en/download) `^24.15.0` or `>=26.0.0`.
- [OpenCode](https://opencode.ai/docs/) 1.18.21 or a later 1.x release. Version 1.18.21 is the tested baseline.
- [Google Chrome](https://www.google.com/chrome/) stable 144 or newer, installed in `/Applications`.
- [Peekaboo 4.2.2](https://github.com/openclaw/Peekaboo/releases/tag/v4.2.2) installed in `/Applications`.

## Quick Start

Clone the repository into a permanent location. The installer creates global symlinks back to this checkout, so moving or deleting it afterward breaks the installed skill and tools.

```bash
git clone https://github.com/zilbonn/opencode_controlmac.git
cd opencode_controlmac
npm ci
npm run install:opencode:dry-run
npm run install:opencode
```

The installer:

- preserves comments, credentials, and unrelated settings in `~/.config/opencode/opencode.jsonc`;
- adds only `controlmac-native`, `controlmac-capture`, and `controlmac-browser`;
- backs up an existing config before changing it;
- symlinks the skill and foreground tools into the global OpenCode directories;
- is idempotent and refuses to replace a real file or directory at either symlink destination.

Restart OpenCode after installation so it reloads the MCP servers and custom tools. If you later move the clone, run the installer again from its new location.

For an isolated config check:

```bash
node scripts/install.mjs --dry-run --config-dir /tmp/opencode-controlmac-test
OPENCODE_CONFIG_DIR=/tmp/opencode-controlmac-test node scripts/install.mjs --dry-run
```

## macOS permissions

Grant **Accessibility**, **Screen & System Audio Recording**, and **Event Synthesizing** to Peekaboo. Open Peekaboo → Settings → Permissions or macOS System Settings → Privacy & Security, then restart Peekaboo and OpenCode after changing permissions.

```bash
./node_modules/.bin/peekaboo permissions status --no-remote --json
./node_modules/.bin/peekaboo permissions status \
  --bridge-socket "$HOME/Library/Application Support/Peekaboo/bridge.sock" \
  --json
npm run doctor
```

The signed Peekaboo app owns Screen Recording permission. The standalone CLI can report it as denied while the app bridge correctly reports it as granted. Automation permission is unnecessary unless an AppleScript/JXA adapter is added; Input Monitoring is not required.

Peekaboo 4.2.2 uses split native routing here: semantic actions use its local runtime (`--no-remote`), while capture and OCR use the permission-aware app bridge. Snapshot and element IDs are scoped to their originating MCP and must not cross between them. The custom wrappers retain Peekaboo's on-demand route only for foreground operations its MCP intentionally refuses.

## Normal Chrome setup

`controlmac-browser` connects directly to the normal Google Chrome stable session with Chrome DevTools MCP's `--auto-connect --channel=stable` mode. It does not use a browser extension.

Enable Chrome's built-in remote debugging once:

1. Open `chrome://inspect/#remote-debugging` in normal Chrome and enable remote debugging.
2. Restart OpenCode so the browser MCP reconnects.
3. Call `list_pages` on `controlmac-browser` to trigger Chrome's connection prompt.
4. Accept the prompt, then call `list_pages` again and select the intended page before any browser action.

Always begin browser work with `list_pages`. If it does not return the intended pages, stop and fix the Chrome connection instead of acting through native Chromium controls.

Use Chrome DevTools MCP for page snapshots, clicks, forms, uploads, waits, and screenshots. Use native Peekaboo only for the omnibox, menus, permission prompts, downloads, and other macOS browser chrome.

`npm run doctor` reports whether normal Chrome remote debugging is reachable and gives setup instructions when it is not. `doctor --logs` includes local debugging output; redaction is best effort, so review it before copying or sharing it.

## Verify the installation

```bash
npm test
npm run doctor
opencode mcp list
```

After restarting OpenCode:

- confirm all three `controlmac-*` MCP servers enumerate tools;
- run a native `see` call and confirm it returns AX elements plus a snapshot ID;
- call `list_pages` on `controlmac-browser` and verify the expected pages;
- use a harmless fixture or temporary document for the first action test.

`npm test` is deterministic. Live suites open visible applications and run only when explicitly enabled:

```bash
CONTROLMAC_RUN_NATIVE_SMOKE=1 npm run test:native
CONTROLMAC_RUN_NATIVE_RECOVERY=1 npm run test:recovery-native
CONTROLMAC_RUN_BROWSER_SMOKE=1 npm run test:browser
CONTROLMAC_RUN_BROWSER_RECOVERY=1 npm run test:recovery-browser
CONTROLMAC_RUN_WORKFLOW_SMOKE=1 npm run test:workflow
```

## Operating rules

- Before browser work, call `list_pages` on `controlmac-browser` and select the intended page.
- Use native Peekaboo for native apps, browser chrome, and macOS dialogs.
- Pass exact numeric PID plus window ID to `controlmac_window_focus`; never target that mutation by application name.
- Treat Accessibility element IDs, browser UIDs, snapshots, and coordinates as snapshot-scoped.
- Reinspect after navigation, scrolling, focus changes, window movement, menus, and dialogs.
- Verify every visible postcondition. Successful dispatch alone is not completion.
- Do not replay typing, submission, upload, or drag until the current state has been inspected.

## Known limitations

- Foreground fallbacks share the real keyboard and pointer and can be disrupted by concurrent user input.
- Permission changes usually require restarting Peekaboo and OpenCode.
- Chrome auto-connect can expose a different active Chrome session than expected; verify `list_pages` before every browser workflow.
- Peekaboo 4.2.2 cannot generically focus an attached TextEdit Save As sheet. Same-directory saves recover through background dialog actions; selecting an arbitrary new directory in that sheet remains unsupported.
- Peekaboo 4.2.2 is unreliable for native AX mutation or exact-window capture of Chromium page content. Use the corresponding browser MCP instead.

## Manual uninstall

1. Quit OpenCode.
2. Remove the three `controlmac-*` entries from `~/.config/opencode/opencode.jsonc`; leave unrelated MCP entries untouched.
3. Confirm the following paths are ControlMac symlinks, then unlink them:

   ```bash
   readlink "$HOME/.config/opencode/skills/control-mac"
   readlink "$HOME/.config/opencode/tools/controlmac.ts"
   unlink "$HOME/.config/opencode/skills/control-mac"
   unlink "$HOME/.config/opencode/tools/controlmac.ts"
   ```

4. Upgrading from an earlier ControlMac release does not delete its old Chrome Beta profile or logs. If no longer needed, manually move `~/Library/Application Support/OpenCodeControl/chrome-beta` and `~/Library/Logs/OpenCodeControl` to the Trash.

Installer-created `opencode.jsonc.bak-*` files are retained for recovery and are not removed automatically.

## License and acknowledgements

ControlMac is released under the [MIT License](LICENSE). Its dependencies retain their own licenses:

- [Peekaboo](https://github.com/openclaw/Peekaboo) — MIT.
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) — Apache-2.0.
- [semver](https://github.com/npm/node-semver) — ISC.
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk), [OpenCode plugin SDK](https://github.com/anomalyco/opencode), and [jsonc-parser](https://github.com/microsoft/node-jsonc-parser) — MIT.

The complete execution policy is in `opencode/skills/control-mac/SKILL.md`. `config/opencode.fragment.jsonc` is a placeholder-based reference; use the installer to generate paths for the current machine.
