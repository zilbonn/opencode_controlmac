# OpenCode ControlMac

Local macOS and Chrome control for [OpenCode](https://opencode.ai/), without a browser extension.

```text
OpenCode + control-mac skill
├── controlmac-native MCP         → Peekaboo local runtime → Accessibility / semantic input
├── controlmac-capture MCP        → Peekaboo app bridge → screenshots / OCR / annotated UI
├── controlmac-browser MCP        → Chrome DevTools MCP → dedicated Chrome Beta profile
├── controlmac-stable-browser MCP → Chrome DevTools MCP → opted-in Chrome stable profile
└── controlmac_* tools            → narrow Peekaboo CLI foreground actions
```

ControlMac adds a global OpenCode skill, an idempotent installer, diagnostics, a profile-safe Chrome Beta launcher, and four foreground wrappers. The skill applies an observe → target → act → verify → recover loop while Peekaboo and Chrome DevTools MCP perform the automation.

## Requirements

- macOS 15 or newer on Apple Silicon.
- [Node.js](https://nodejs.org/en/download) `^24.15.0` or `>=26.0.0`.
- [OpenCode](https://opencode.ai/docs/) 1.18.21 or a later 1.x release. Version 1.18.21 is the tested baseline.
- [Google Chrome Beta](https://www.google.com/chrome/beta/) installed in `/Applications`.
- [Peekaboo 4.2.2](https://github.com/openclaw/Peekaboo/releases/tag/v4.2.2) installed in `/Applications`.
- Google Chrome 144 or newer only for the optional existing-stable-profile connection.

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
- adds only `controlmac-native`, `controlmac-capture`, `controlmac-browser`, and `controlmac-stable-browser`;
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

## Dedicated Chrome Beta

`controlmac-browser` owns a persistent profile at:

```text
~/Library/Application Support/OpenCodeControl/chrome-beta
```

The launcher starts Chrome Beta with `--remote-debugging-port=0`, then discovers the assigned loopback endpoint exclusively through that profile's `DevToolsActivePort` file. Before reuse it validates the port, browser WebSocket path, `/json/version` response, and exact endpoint ownership. It never scans for or adopts an unrelated Chrome debugging endpoint, deletes profile locks, or silently selects another profile.

The first launch creates a separate browser profile. Sign in there manually when a workflow needs an authenticated session. One active controller can own this dedicated profile at a time.

An explicit `CONTROLMAC_CDP_URL` selects **connect-only** mode. The URL must identify an already-running CDP endpoint; ControlMac never launches a local browser in this mode. The old split CDP host and port settings are unsupported and produce a migration error.

Safe checks:

```bash
npm run chrome:check
npm run doctor
npm run doctor -- --json
npm run doctor -- --logs
```

`chrome:check` reports dedicated-profile or external-URL mode, profile ownership, the resolved endpoint, and any blocker. It does not launch Chrome. `chrome:ensure` may launch or reuse the dedicated Beta profile but does not start the MCP server.

`doctor --logs` includes local debugging output. Redaction is best effort: review its output before copying or sharing it.

### Launcher overrides

| Variable | Purpose |
|---|---|
| `CONTROLMAC_CHROME_PATH` | Chrome Beta executable |
| `CONTROLMAC_CHROME_USER_DATA_DIR` | Dedicated profile directory |
| `CONTROLMAC_CDP_URL` | Existing CDP endpoint; connect-only, never launches Chrome |
| `CONTROLMAC_CHROME_MCP_PATH` | Chrome DevTools MCP executable |
| `CONTROLMAC_CHROME_MCP_LOG_PATH` | Chrome DevTools MCP log file |
| `CONTROLMAC_STARTUP_TIMEOUT_MS` | Browser readiness timeout |
| `CONTROLMAC_POLL_INTERVAL_MS` | Readiness polling interval |

## Existing Chrome stable profile

Chrome 144+ can expose its existing stable default profile through a built-in local consent flow:

1. In the intended stable Chrome profile, open `chrome://inspect/#remote-debugging` and enable remote debugging.
2. Restart OpenCode, then accept Chrome's remote-debugging prompt.
3. Call `list_pages` on `controlmac-stable-browser`.
4. Continue only if `list_pages` returns the intended pages.

Auto-connect does not prove which profile was selected. If several stable profiles are active, Chrome may expose its default profile. Never act when `list_pages` shows the wrong pages; use the dedicated Chrome Beta profile instead.

Use Chrome DevTools MCP for page snapshots, clicks, forms, uploads, waits, and screenshots. Use native Peekaboo only for the omnibox, menus, permission prompts, downloads, and other macOS browser chrome.

## Verify the installation

```bash
npm test
npm run doctor
opencode mcp list
```

After restarting OpenCode:

- confirm all four `controlmac-*` MCP servers enumerate tools;
- run a native `see` call and confirm it returns AX elements plus a snapshot ID;
- call `list_pages` on the chosen browser MCP and verify the expected profile and pages;
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

- Use `controlmac-browser` for the dedicated Beta profile and `controlmac-stable-browser` only after verifying `list_pages`.
- Use native Peekaboo for native apps, browser chrome, and macOS dialogs.
- Pass exact numeric PID plus window ID to `controlmac_window_focus`; never target that mutation by application name.
- Treat Accessibility element IDs, browser UIDs, snapshots, and coordinates as snapshot-scoped.
- Reinspect after navigation, scrolling, focus changes, window movement, menus, and dialogs.
- Verify every visible postcondition. Successful dispatch alone is not completion.
- Do not replay typing, submission, upload, or drag until the current state has been inspected.

## Known limitations

- Foreground fallbacks share the real keyboard and pointer and can be disrupted by concurrent user input.
- Permission changes usually require restarting Peekaboo and OpenCode.
- Only one controller should use the dedicated Chrome Beta profile at a time; an existing profile lock is reported, never removed.
- Stable Chrome auto-connect can select the default rather than the intended non-default profile.
- Peekaboo 4.2.2 cannot generically focus an attached TextEdit Save As sheet. Same-directory saves recover through background dialog actions; selecting an arbitrary new directory in that sheet remains unsupported.
- Peekaboo 4.2.2 is unreliable for native AX mutation or exact-window capture of Chromium page content. Use the corresponding browser MCP instead.

## Manual uninstall

1. Quit OpenCode.
2. Remove the four `controlmac-*` entries from `~/.config/opencode/opencode.jsonc`; leave unrelated MCP entries untouched.
3. Confirm the following paths are ControlMac symlinks, then unlink them:

   ```bash
   readlink "$HOME/.config/opencode/skills/control-mac"
   readlink "$HOME/.config/opencode/tools/controlmac.ts"
   unlink "$HOME/.config/opencode/skills/control-mac"
   unlink "$HOME/.config/opencode/tools/controlmac.ts"
   ```

4. If no longer needed, move the dedicated profile at `~/Library/Application Support/OpenCodeControl/chrome-beta` and ControlMac logs in `~/Library/Logs/OpenCodeControl` to the Trash.

Installer-created `opencode.jsonc.bak-*` files are retained for recovery and are not removed automatically.

## License and acknowledgements

ControlMac is released under the [MIT License](LICENSE). Its dependencies retain their own licenses:

- [Peekaboo](https://github.com/openclaw/Peekaboo) — MIT.
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) — Apache-2.0.
- [semver](https://github.com/npm/node-semver) — ISC.
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk), [OpenCode plugin SDK](https://github.com/anomalyco/opencode), and [jsonc-parser](https://github.com/microsoft/node-jsonc-parser) — MIT.

The complete execution policy is in `opencode/skills/control-mac/SKILL.md`. `config/opencode.fragment.jsonc` is a placeholder-based reference; use the installer to generate paths for the current machine.
