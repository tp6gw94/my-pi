// Pi extension that notifies cmux when the agent finishes a turn or errors.
//
// Two modes:
// 1. Bridge mode: CMUX_NOTIFY_URL is set (e.g. by bin/run-pi-sandbox). The
//    extension POSTs JSON to that URL and the host-side bridge shells out to
//    cmux.
// 2. Direct mode: CMUX_NOTIFY_URL is unset. The extension spawns `cmux notify`
//    directly. This is used when pi is run outside the sandbox.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const NOTIFY_TIMEOUT_MS = 5_000

interface CmuxTarget {
  workspace?: string
  surface?: string
  window?: string
}

interface NotifyPayload {
  title: string
  subtitle?: string
  body?: string
  status?: string
  icon?: string
  color?: string
  notify?: boolean
  messages?: unknown[]
  cmux: CmuxTarget
}

let target: CmuxTarget = {}
let notifyUrl: string | null = null

function loadConfig() {
  notifyUrl = process.env.CMUX_NOTIFY_URL || null
  const workspace = process.env.CMUX_WORKSPACE_ID || ""
  const surface = process.env.CMUX_SURFACE_ID || ""
  const window = process.env.CMUX_WINDOW_ID || ""

  target = { workspace, surface, window }

  if (notifyUrl) {
    console.log("[cmux-notify] bridge mode, url:", notifyUrl, "target:", target)
  } else {
    console.log("[cmux-notify] direct mode, target:", target)
  }
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (part && typeof part === "object") {
        const type = (part as Record<string, unknown>).type
        const text = (part as Record<string, unknown>).text
        if (type === "text" && typeof text === "string") return text
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

const MAX_BODY_LENGTH = 200

function truncate(str: string, maxLen: number): string {
  const trimmed = str.trim()
  if (trimmed.length <= maxLen) return trimmed
  return trimmed.slice(0, maxLen) + "…"
}

function getStatusFromMessages(messages: unknown[] | undefined): { subtitle: string; body: string } {
  let subtitle = "Waiting"
  let body = ""

  if (!Array.isArray(messages) || messages.length === 0) {
    return { subtitle, body }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown> | undefined
    if (!msg || typeof msg !== "object") continue
    const role = String(msg.role ?? "")
    if (role === "assistant") {
      const content = extractTextFromContent(msg.content)
      const text = content.trim()
      if (!text) continue
      body = truncate(content, MAX_BODY_LENGTH)
      if (/error|fail|exception|timed out/i.test(content)) {
        subtitle = "Error"
      }
      break
    }
  }

  return { subtitle, body }
}

async function notifyViaBridge(payload: Partial<NotifyPayload>) {
  if (!notifyUrl) return

  const body: NotifyPayload = {
    title: "Pi",
    subtitle: "Waiting",
    notify: true,
    cmux: target,
    ...payload,
  }

  try {
    const response = await fetch(notifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    })

    if (!response.ok) {
      console.warn("[cmux-notify] notify failed:", response.status, await response.text())
    }
  } catch (err) {
    console.warn("[cmux-notify] notify error:", err)
  }
}

async function notifyDirectly(payload: Partial<NotifyPayload>) {
  const subtitle = payload.subtitle || "Waiting"
  const body = payload.body || subtitle || "Pi"

  const args = ["notify", "--title", "Pi", "--subtitle", subtitle, "--body", body]
  if (target.window) args.push("--window", target.window)
  else if (target.workspace) args.push("--workspace", target.workspace)
  else if (target.surface) args.push("--surface", target.surface)

  try {
    const { spawn } = await import("node:child_process")
    await new Promise<void>((resolve, reject) => {
      const child = spawn("cmux", args, { stdio: ["ignore", "pipe", "pipe"] })
      let stderr = ""
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on("error", (error: Error) => {
        reject(error)
      })
      child.on("exit", (code: number | null) => {
        if (code === 0) {
          resolve()
          return
        }
        const detail = stderr.trim()
        reject(new Error(`cmux notify exited with ${code}${detail ? ": " + detail : ""}`))
      })
    })
  } catch (err) {
    console.warn("[cmux-notify] direct notify error:", err)
  }
}

async function notify(payload: Partial<NotifyPayload>) {
  if (notifyUrl) {
    await notifyViaBridge(payload)
  } else {
    await notifyDirectly(payload)
  }
}

export default async function (pi: ExtensionAPI) {
  loadConfig()

  pi.on("agent_end", async (event: unknown, _ctx: unknown) => {
    const ev = event as Record<string, unknown> | undefined
    const messages = ev?.messages as unknown[] | undefined
    const { subtitle, body } = getStatusFromMessages(messages)
    await notify({
      title: "Pi",
      subtitle,
      body,
      status: subtitle,
      icon: subtitle === "Error" ? "xmark" : "sparkle",
      color: subtitle === "Error" ? "#ff3b30" : "#00cc66",
      messages,
    })
  })
}
