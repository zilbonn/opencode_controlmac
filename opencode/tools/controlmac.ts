import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { tool } from "@opencode-ai/plugin"

const PEEKABOO = fileURLToPath(
  new URL("../../node_modules/.bin/peekaboo", import.meta.url),
)

const modifier = tool.schema.enum([
  "cmd",
  "command",
  "shift",
  "option",
  "alt",
  "ctrl",
  "control",
  "fn",
])

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  closeSignal: string | null
}

function runPeekaboo(
  argv: string[],
  signal: AbortSignal,
  timeoutMs: number,
  operation: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(`ControlMac ${operation} was cancelled before dispatch`))
      return
    }

    const child = spawn(PEEKABOO, argv, {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut = false
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    let exitCode: number | null = null
    let closeSignal: string | null = null

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      signal.removeEventListener("abort", abort)

      if (error) reject(error)
      else resolve({ stdout, stderr, exitCode, closeSignal })
    }

    const abort = () => {
      child.kill("SIGTERM")
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000)
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000)
    }, timeoutMs)

    signal.addEventListener("abort", abort, { once: true })
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", (error) => finish(error))
    child.once("close", (code, signalName) => {
      exitCode = code
      closeSignal = signalName
      if (signal.aborted) {
        finish(
          new Error(
            `ControlMac ${operation} was cancelled; reobserve before retrying`,
          ),
        )
        return
      }
      if (timedOut) {
        finish(
          new Error(
            `Peekaboo ${operation} timed out after ${timeoutMs}ms; reobserve before retrying`,
          ),
        )
        return
      }
      finish()
    })
  })
}

function normalizeModifiers(values: string[] | undefined): string[] {
  const aliases: Record<string, string> = {
    command: "cmd",
    alt: "option",
    control: "ctrl",
  }
  return [...new Set((values ?? []).map((value) => aliases[value] ?? value))]
}

function resolveOpenTarget(value: string, directory: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  if (value === "~") return os.homedir()
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
  return path.isAbsolute(value) ? value : path.resolve(directory, value)
}

function point(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.x !== "number" || typeof candidate.y !== "number") {
    return null
  }
  return { x: candidate.x, y: candidate.y }
}

type SnapshotElement = {
  frame?: [[number, number], [number, number]]
}

type SnapshotMap = {
  applicationBundleId?: string
  applicationName?: string
  applicationProcessId?: number
  windowID?: number
  uiMap?: Record<string, SnapshotElement>
}

async function readSnapshot(snapshotId: string): Promise<SnapshotMap> {
  if (!/^\d+-\d+$/.test(snapshotId)) {
    throw new Error("snapshot must be a Peekaboo snapshot ID from a fresh native inspection")
  }
  const snapshotPath = path.join(
    os.homedir(),
    ".peekaboo",
    "snapshots",
    snapshotId,
    "snapshot.json",
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(snapshotPath, "utf8"))
  } catch (error) {
    throw new Error(
      `Could not read Peekaboo snapshot ${snapshotId}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const snapshot = objectOrNull(parsed)
  if (!snapshot) throw new Error(`Peekaboo snapshot ${snapshotId} is invalid`)
  return snapshot as SnapshotMap
}

function validateSnapshotTarget(
  snapshot: SnapshotMap,
  app: string | undefined,
  windowId: number | undefined,
): void {
  if (windowId !== undefined && snapshot.windowID !== windowId) {
    throw new Error(
      `Snapshot window ${snapshot.windowID ?? "unknown"} does not match requested window ${windowId}`,
    )
  }
  if (!app) return
  const pid = app.match(/^PID:(\d+)$/i)
  if (pid) {
    if (snapshot.applicationProcessId !== Number(pid[1])) {
      throw new Error(
        `Snapshot PID ${snapshot.applicationProcessId ?? "unknown"} does not match requested ${app}`,
      )
    }
    return
  }
  const expected = app.toLocaleLowerCase()
  const matches = [snapshot.applicationName, snapshot.applicationBundleId]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLocaleLowerCase() === expected)
  if (!matches) {
    throw new Error(
      `Snapshot application ${snapshot.applicationName ?? snapshot.applicationBundleId ?? "unknown"} does not match requested ${app}`,
    )
  }
}

function snapshotBoundPoint(
  snapshot: SnapshotMap,
  value: string,
  label: string,
): { x: number; y: number } {
  const coordinate = value.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/)
  if (coordinate) return { x: Number(coordinate[1]), y: Number(coordinate[2]) }

  const frame = snapshot.uiMap?.[value]?.frame
  if (
    !frame ||
    !frame.flat().every((component) => typeof component === "number" && Number.isFinite(component))
  ) {
    throw new Error(`${label} element ${value} is not present in the supplied snapshot`)
  }
  return {
    x: frame[0][0] + frame[1][0] / 2,
    y: frame[0][1] + frame[1][1] / 2,
  }
}

function coordinateArgument(value: { x: number; y: number }): string {
  return `${value.x},${value.y}`
}

type ParsedDispatch = {
  dispatch: Record<string, unknown>
  data: Record<string, unknown>
  exitCode: number | null
  partialDispatch: boolean
  mutationDispatched: boolean
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseDispatch(
  result: CommandResult,
  operation: string,
): ParsedDispatch {
  const serialized = result.stdout.trim() || result.stderr.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new Error(
      `Peekaboo ${operation} returned invalid JSON: ${serialized.slice(-4_000)}. Reobserve before retrying.`,
    )
  }

  const dispatch = objectOrNull(parsed)
  if (!dispatch) {
    throw new Error(
      `Peekaboo ${operation} returned an invalid response envelope. Reobserve before retrying.`,
    )
  }

  const outcome = objectOrNull(dispatch.outcome)
  const error = objectOrNull(dispatch.error)
  const mutationDispatched =
    dispatch.mutation_dispatched === true ||
    outcome?.mutation_dispatched === true ||
    error?.mutation_dispatched === true
  const successful = dispatch.success === true
  if (!successful && !mutationDispatched) {
    const exit = result.exitCode ?? "unknown"
    throw new Error(
      `Peekaboo ${operation} failed before dispatch (exit ${exit}${result.closeSignal ? `, signal ${result.closeSignal}` : ""}): ${JSON.stringify(dispatch)}.`,
    )
  }

  return {
    dispatch,
    data: objectOrNull(dispatch.data) ?? {},
    exitCode: result.exitCode,
    partialDispatch: !successful || result.exitCode !== 0,
    mutationDispatched,
  }
}

async function dispatchPeekaboo(
  argv: string[],
  signal: AbortSignal,
  timeoutMs: number,
  operation: string,
): Promise<ParsedDispatch> {
  await access(PEEKABOO, constants.X_OK).catch(() => {
    throw new Error(
      `Pinned Peekaboo CLI is missing or not executable at ${PEEKABOO}`,
    )
  })
  return parseDispatch(
    await runPeekaboo(argv, signal, timeoutMs, operation),
    operation,
  )
}

function unverifiedResult(
  action: string,
  parsed: ParsedDispatch,
  next: string,
  details: Record<string, unknown> = {},
): string {
  return JSON.stringify(
    {
      status: "dispatched_unverified",
      needs_reinspection: true,
      action,
      ...details,
      data: parsed.data,
      partial_dispatch: parsed.partialDispatch,
      mutation_dispatched: parsed.mutationDispatched,
      peekaboo_exit_code: parsed.exitCode,
      outcome: parsed.dispatch.outcome ?? null,
      error: parsed.dispatch.error ?? null,
      dispatch: parsed.dispatch,
      next,
    },
    null,
    2,
  )
}

export const app = tool({
  description:
    "Launch, open, activate, unhide, relaunch, or switch to one exact macOS application through Peekaboo's foreground CLI. Use this only when the background-only native MCP refuses the action, then reinspect the app/window.",
  args: {
    action: tool.schema
      .enum(["launch", "open", "focus", "unhide", "relaunch", "switch"])
      .describe("Foreground application action"),
    app: tool.schema
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Exact application name/path, or PID:1234 for non-launch actions"),
    bundle_id: tool.schema
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Exact bundle ID; use instead of app"),
    open_targets: tool.schema
      .array(tool.schema.string().trim().min(1))
      .min(1)
      .max(16)
      .optional()
      .describe("Files or URLs to open; required for open and optional for launch"),
    new_instance: tool.schema
      .boolean()
      .optional()
      .describe("Create a distinct process; launch/open only"),
    wait_ready: tool.schema
      .boolean()
      .optional()
      .describe("Wait for launch readiness; launch/open/relaunch only"),
    wait_for_window: tool.schema
      .boolean()
      .optional()
      .describe("Wait for an exact window; launch/open only"),
    relaunch_wait_ms: tool.schema
      .number()
      .int()
      .min(0)
      .max(15_000)
      .optional()
      .describe("Delay between quit and launch; relaunch only"),
    timeout_ms: tool.schema
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .optional()
      .describe("Overall command timeout; defaults to 30000"),
  },
  async execute(args, context) {
    const hasApp = args.app !== undefined
    const hasBundle = args.bundle_id !== undefined
    if (hasApp === hasBundle) {
      throw new Error("Provide exactly one application target: app or bundle_id")
    }

    const launchAction = args.action === "launch" || args.action === "open"
    if (launchAction && args.app?.toUpperCase().startsWith("PID:")) {
      throw new Error("PID targets are not valid for launch or open")
    }
    if (args.action === "open" && !args.open_targets?.length) {
      throw new Error("The open action requires at least one open_targets entry")
    }
    if (!launchAction && args.open_targets !== undefined) {
      throw new Error("open_targets is valid only for launch or open")
    }
    if (!launchAction && args.new_instance !== undefined) {
      throw new Error("new_instance is valid only for launch or open")
    }
    if (!["launch", "open", "relaunch"].includes(args.action) && args.wait_ready !== undefined) {
      throw new Error("wait_ready is valid only for launch, open, or relaunch")
    }
    if (!launchAction && args.wait_for_window !== undefined) {
      throw new Error("wait_for_window is valid only for launch or open")
    }
    if (args.action !== "relaunch" && args.relaunch_wait_ms !== undefined) {
      throw new Error("relaunch_wait_ms is valid only for relaunch")
    }

    const target = args.app ?? args.bundle_id!
    const argv = ["app"]
    if (launchAction) {
      argv.push("launch")
      if (hasBundle) argv.push("--bundle-id", args.bundle_id!)
      else argv.push(args.app!)
      for (const openTarget of args.open_targets ?? []) {
        argv.push("--open", resolveOpenTarget(openTarget, context.directory))
      }
      if (args.new_instance) argv.push("--new-instance")
      if (args.wait_ready) argv.push("--wait-ready")
      if (args.wait_for_window) argv.push("--wait-for-window")
      argv.push("--foreground")
    } else if (args.action === "focus") {
      argv.push("focus", "--app", target)
    } else if (args.action === "unhide") {
      argv.push("unhide", "--app", target, "--activate")
    } else if (args.action === "relaunch") {
      argv.push("relaunch", "--app", target, "--foreground")
      if (args.wait_ready) argv.push("--wait-until-ready")
      if (args.relaunch_wait_ms !== undefined) {
        argv.push("--wait", `${args.relaunch_wait_ms}ms`)
      }
    } else {
      argv.push("switch", "--to", target, "--verify")
    }
    argv.push("--json")

    const timeoutMs = args.timeout_ms ?? 30_000
    context.metadata({ title: `${args.action} ${target}` })
    const parsed = await dispatchPeekaboo(
      argv,
      context.abort,
      timeoutMs,
      `app ${args.action}`,
    )
    return unverifiedResult(
      args.action,
      parsed,
      "Reinspect the exact application and requested window before continuing or retrying.",
    )
  },
})

export const dialog_file = tool({
  description:
    "Operate one native macOS open/save dialog through Peekaboo's foreground CLI. Use this only when the background-only native MCP refuses file-dialog input, then reinspect the dialog or resulting app state. Peekaboo 4.2.2 cannot target an attached TextEdit Save As sheet; use the control-mac skill's exact background dialog recovery for same-directory saves.",
  args: {
    app: tool.schema
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Exact application name, bundle ID, or PID:1234"),
    window_id: tool.schema
      .number()
      .int()
      .positive()
      .optional()
      .describe("Exact dialog/window ID; app may also be supplied as a consistency check"),
    path: tool.schema
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Absolute directory or full file path to navigate to"),
    name: tool.schema
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Filename for a save dialog"),
    select: tool.schema
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Exact action button label, or default for the OK button"),
    ensure_expanded: tool.schema
      .boolean()
      .optional()
      .describe("Expand the dialog before setting its path"),
    timeout_ms: tool.schema
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .optional()
      .describe("File-dialog timeout; defaults to 30000"),
  },
  async execute(args, context) {
    if (args.app === undefined && args.window_id === undefined) {
      throw new Error("Provide an exact dialog target with app or window_id")
    }
    if (args.path === undefined && args.name === undefined && args.select === undefined) {
      throw new Error("Provide at least one dialog operation: path, name, or select")
    }

    const timeoutMs = args.timeout_ms ?? 30_000
    const argv = [
      "dialog",
      "file",
      "--timeout",
      `${timeoutMs}ms`,
    ]
    if (args.app) argv.push("--app", args.app)
    if (args.window_id !== undefined) {
      argv.push("--window-id", String(args.window_id))
    }
    if (args.path) argv.push("--path", args.path)
    if (args.name) argv.push("--name", args.name)
    if (args.select) argv.push("--select", args.select)
    if (args.ensure_expanded) argv.push("--ensure-expanded")
    argv.push("--foreground", "--json")

    context.metadata({ title: `Handling file dialog${args.app ? ` in ${args.app}` : ""}` })
    const parsed = await dispatchPeekaboo(
      argv,
      context.abort,
      timeoutMs + 5_000,
      "dialog file",
    )
    return unverifiedResult(
      "dialog_file",
      parsed,
      "Reinspect the dialog and verify the selected path, filename, button result, or resulting application state.",
    )
  },
})

export const window_focus = tool({
  description:
    "Focus one exact native macOS window through Peekaboo's foreground CLI, including cross-Space focus. Requires an exact PID and window ID so Peekaboo never falls back to a name-based application inventory.",
  args: {
    pid: tool.schema
      .number()
      .int()
      .positive()
      .describe("Exact positive process ID from the current native inspection"),
    window_id: tool.schema
      .number()
      .int()
      .positive()
      .describe("Exact positive window ID from the current native inspection"),
    space_mode: tool.schema
      .enum(["switch", "bring_to_current"])
      .optional()
      .describe("Switch to the window's Space or move it to the current Space"),
    timeout_ms: tool.schema
      .number()
      .int()
      .min(500)
      .max(15_000)
      .optional()
      .describe("Focus timeout; defaults to 5000"),
    retries: tool.schema
      .number()
      .int()
      .min(0)
      .max(3)
      .optional()
      .describe("Peekaboo focus retries; defaults to 1"),
  },
  async execute(args, context) {
    if (!Number.isInteger(args.pid) || args.pid <= 0) {
      throw new Error("Provide an exact positive pid")
    }
    if (!Number.isInteger(args.window_id) || args.window_id <= 0) {
      throw new Error("Provide an exact positive window_id")
    }

    const timeoutMs = args.timeout_ms ?? 5_000
    const retries = args.retries ?? 1
    const argv = [
      "window",
      "focus",
      "--pid",
      String(args.pid),
      "--window-id",
      String(args.window_id),
      "--focus-timeout",
      `${timeoutMs}ms`,
      "--focus-retry-count",
      String(retries),
    ]
    if (args.space_mode === "switch") argv.push("--space-switch")
    if (args.space_mode === "bring_to_current") {
      argv.push("--bring-to-current-space")
    }
    argv.push("--verify", "--json")

    context.metadata({ title: "Focusing exact macOS window" })
    const parsed = await dispatchPeekaboo(
      argv,
      context.abort,
      timeoutMs + 5_000,
      "window focus",
    )
    return unverifiedResult(
      "window_focus",
      parsed,
      "Reinspect the exact window and verify its frontmost, focused, and Space state before continuing.",
    )
  },
})

export const drag = tool({
  description:
    "Drag a native macOS UI element or coordinate with Peekaboo's shared foreground cursor. Requires a fresh snapshot and exactly one destination. The result is never self-verifying; inspect the destination afterward.",
  args: {
    app: tool.schema
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Exact source application name, bundle ID, or PID:1234"),
    window_id: tool.schema
      .number()
      .int()
      .positive()
      .optional()
      .describe("Exact source window ID from the current inspection"),
    snapshot: tool.schema
      .string()
      .trim()
      .min(1)
      .describe("Fresh Peekaboo snapshot ID that contains any element IDs"),
    from: tool.schema
      .string()
      .trim()
      .min(1)
      .describe('Source element ID or snapshot-bound coordinate "x,y"'),
    to: tool.schema
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Destination element ID or snapshot-bound coordinate "x,y"'),
    to_app: tool.schema
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Destination application, such as Finder or Trash"),
    duration_ms: tool.schema
      .number()
      .int()
      .min(50)
      .max(30_000)
      .optional()
      .describe("Drag duration in milliseconds; defaults to 500"),
    steps: tool.schema
      .number()
      .int()
      .min(1)
      .max(96)
      .optional()
      .describe("Interpolation steps; defaults to 20"),
    modifiers: tool.schema
      .array(modifier)
      .max(5)
      .optional()
      .describe("Modifier keys held during the drag"),
  },
  async execute(args, context) {
    const hasTo = args.to !== undefined
    const hasToApp = args.to_app !== undefined
    if (hasTo === hasToApp) {
      throw new Error("Provide exactly one destination: to or to_app")
    }

    const durationMs = args.duration_ms ?? 500
    const steps = args.steps ?? 20
    const snapshot = await readSnapshot(args.snapshot)
    validateSnapshotTarget(snapshot, args.app, args.window_id)
    const sourcePoint = snapshotBoundPoint(snapshot, args.from, "Source")
    const destinationPoint = hasTo
      ? snapshotBoundPoint(snapshot, args.to!, "Destination")
      : undefined
    const argv = [
      "drag",
      "--from",
      coordinateArgument(sourcePoint),
      hasTo ? "--to" : "--to-app",
      hasTo ? coordinateArgument(destinationPoint!) : args.to_app!,
      "--duration",
      `${durationMs}ms`,
      "--steps",
      String(steps),
    ]

    const modifiers = normalizeModifiers(args.modifiers)
    if (modifiers.length > 0) {
      argv.push("--modifiers", modifiers.join(","))
    }
    argv.push("--no-auto-focus", "--foreground", "--json")

    context.metadata({ title: "Dragging native macOS UI" })
    const parsed = await dispatchPeekaboo(
      argv,
      context.abort,
      Math.max(15_000, durationMs + 10_000),
      "drag",
    )
    const start = point(parsed.data.from) ?? sourcePoint
    const end = point(parsed.data.to) ?? destinationPoint ?? null
    if (parsed.partialDispatch) {
      return unverifiedResult(
        "drag",
        parsed,
        "The drag may have been dispatched. Reinspect both endpoints before deciding whether any retry is safe.",
        start && end ? { start, end } : {},
      )
    }
    if (!start || !end) {
      throw new Error(
        `Peekaboo response did not contain drag coordinates: ${JSON.stringify(parsed.dispatch)}. Reobserve before retrying.`,
      )
    }

    return JSON.stringify(
      {
        status: "dispatched_unverified",
        needs_reinspection: true,
        action: "drag",
        start,
        end,
        data: parsed.data,
        partial_dispatch: parsed.partialDispatch,
        mutation_dispatched: parsed.mutationDispatched,
        peekaboo_exit_code: parsed.exitCode,
        outcome: parsed.dispatch.outcome ?? null,
        error: parsed.dispatch.error ?? null,
        dispatch: parsed.dispatch,
        next: "Reinspect the destination and verify the expected state before continuing or retrying.",
      },
      null,
      2,
    )
  },
})
