#!/usr/bin/env node
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

function readArg(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return fallback;
  return args[index + 1];
}

const host = readArg("--host", process.env.CMUX_NOTIFY_HOST || "127.0.0.1");
const port = Number(readArg("--port", process.env.CMUX_NOTIFY_PORT || "17363"));
const token = process.env.CMUX_NOTIFY_TOKEN || "";

function log(message, fields = {}) {
  const suffix = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
  process.stdout.write(`[${new Date().toISOString()}] ${message}${suffix}\n`);
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_REQUEST_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function normalize(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 240);
}

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const type = part.type;
        const text = part.text;
        if (type === "text" && typeof text === "string") return text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function getLastAssistantBody(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const role = String(msg.role ?? "");
    if (role === "assistant") {
      const text = extractTextFromContent(msg.content).trim();
      if (text) return text.slice(0, 240);
    }
  }
  return "";
}

function targetFromPayload(payload) {
  const cmux = payload && typeof payload.cmux === "object" ? payload.cmux : {};
  return {
    window: normalize(cmux.window, ""),
    workspace: normalize(cmux.workspace, ""),
    surface: normalize(cmux.surface, ""),
  };
}

function targetArgs(target) {
  const result = [];
  if (target.window) result.push("--window", target.window);
  if (target.workspace) result.push("--workspace", target.workspace);
  if (target.surface) result.push("--surface", target.surface);
  return result;
}

function runCmux(args, description) {
  return new Promise((resolve, reject) => {
    log("cmux command start", { description, args });
    const child = spawn("cmux", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      log("cmux command error", { description, error: error.message });
      reject(error);
    });
    child.on("exit", (code) => {
      if (code === 0) {
        log("cmux command ok", { description });
        resolve();
        return;
      }
      const detail = stderr.trim();
      const error = new Error(`${description} exited with ${code}${detail ? ": " + detail : ""}`);
      log("cmux command failed", { description, code, stderr: detail });
      reject(error);
    });
  });
}

function runCmuxWithOutput(args, description) {
  return new Promise((resolve, reject) => {
    log("cmux command start", { description, args });
    const child = spawn("cmux", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      log("cmux command error", { description, error: error.message });
      reject(error);
    });
    child.on("exit", (code) => {
      if (code === 0) {
        log("cmux command ok", { description });
        resolve(stdout);
        return;
      }
      const detail = stderr.trim();
      const error = new Error(`${description} exited with ${code}${detail ? ": " + detail : ""}`);
      log("cmux command failed", { description, code, stderr: detail });
      reject(error);
    });
  });
}

async function runCmuxRpc(method, params) {
  const output = await runCmuxWithOutput(
    ["rpc", method, JSON.stringify(params)],
    `cmux rpc ${method}`
  );
  return JSON.parse(output || "{}");
}

function formatMessagesForTitle(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const parts = [];
  let chars = 0;
  const MAX_CHARS = 2000;
  for (let i = 0; i < messages.length && chars < MAX_CHARS; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const role = String(msg.role ?? "");
    if (role !== "user" && role !== "assistant") continue;
    const text = extractTextFromContent(msg.content).trim();
    if (!text) continue;
    const snippet = text.slice(0, Math.min(text.length, MAX_CHARS - chars));
    parts.push(`${role}: ${snippet}`);
    chars += snippet.length + role.length + 2;
  }
  return parts.join("\n");
}

async function generateTitle(messages) {
  const conversation = formatMessagesForTitle(messages);
  if (!conversation) {
    throw new Error("no conversation text to summarize");
  }

  const prompt = `Summarize the following coding assistant conversation into a concise 2-5 word workspace title. Reply with ONLY the title, no quotes, no explanation, no punctuation at the end.\n\n${conversation}`;

  return new Promise((resolve, reject) => {
    log("generating title");
    const child = spawn("pi", ["-p", "--no-session", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      log("title generation error", { error: error.message });
      reject(error);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        const detail = stderr.trim();
        log("title generation failed", { code, stderr: detail });
        reject(new Error(`pi exited with ${code}${detail ? ": " + detail : ""}`));
        return;
      }
      const title = stdout.trim().replace(/^["']|["']$/g, "").split("\n")[0].trim();
      if (!title) {
        reject(new Error("pi returned empty title"));
        return;
      }
      log("title generated", { title });
      resolve(title);
    });
  });
}

async function runCmuxAutoRename({ workspaceId, title, messages }) {
  const resolvedTitle = title || (await generateTitle(messages));
  const normalizedTitle = normalize(resolvedTitle, "").slice(0, 60);
  if (!normalizedTitle) {
    throw new Error("empty title");
  }

  const result = await runCmuxRpc("workspace.set_auto_title", {
    workspace_id: workspaceId,
    title: normalizedTitle,
  });

  log("auto rename result", { workspaceId, title: normalizedTitle, result });
  return result;
}

async function runCmuxNotify({ title, subtitle, body, target }) {
  const baseArgs = ["--title", title, "--subtitle", subtitle, "--body", body];
  const notifyArgs = ["notify", ...targetArgs(target), ...baseArgs];

  const hasTarget = Boolean(target.window || target.workspace || target.surface);
  try {
    await runCmux(notifyArgs, "cmux notify");
  } catch (error) {
    if (hasTarget && /not found/i.test(error.message)) {
      log("cmux notify retry without target", { reason: error.message });
      await runCmux(["notify", ...baseArgs], "cmux notify");
      return;
    }
    throw error;
  }

  if (target.surface || target.workspace) {
    await runCmux(["trigger-flash", ...targetArgs(target)], "cmux trigger-flash");
  }
}

async function runCmuxStatus({ target, status, icon, color }) {
  const args = ["set-status", "pi-agent", status];
  if (icon) args.push("--icon", icon);
  if (color) args.push("--color", color);
  // set-status only supports --workspace (and --window). Passing an invalid
  // surface ref causes the command to fail, so strip it for status updates.
  const statusTarget = { window: target.window, workspace: target.workspace, surface: "" };
  args.push(...targetArgs(statusTarget));
  await runCmux(args, "cmux set-status");
}

async function handleStatus(payload, target) {
  const status = normalize(payload.status, "");
  if (!status) return;
  await runCmuxStatus({
    target,
    status,
    icon: typeof payload.icon === "string" ? payload.icon : undefined,
    color: typeof payload.color === "string" ? payload.color : undefined,
  });
}

async function handleNotify(req, res, rawBody) {
  const payload = JSON.parse(rawBody || "{}");
  const target = targetFromPayload(payload);

  log("notify received", {
    remoteAddress: req.socket.remoteAddress,
    title: normalize(payload.title, ""),
    target,
  });

  // Always update sidebar status if a status is provided.
  await handleStatus(payload, target);

  // Send a desktop notification unless explicitly disabled.
  if (payload.notify !== false) {
    let notifyBody = normalize(payload.body, "");
    // If the extension sent an empty/fallback body but included raw messages,
    // re-extract the last assistant text here so the notification is useful.
    if (!notifyBody || notifyBody === "Pi is ready for input") {
      const fromMessages = getLastAssistantBody(payload.messages);
      if (fromMessages) notifyBody = fromMessages;
    }
    const message = {
      title: normalize(payload.title, "Pi"),
      subtitle: normalize(payload.subtitle, ""),
      body: notifyBody,
      target,
    };
    await runCmuxNotify(message);
  }

  log("notify delivered", { target });
  sendJson(res, 200, { ok: true });
}

async function handleRename(req, res, rawBody) {
  const payload = JSON.parse(rawBody || "{}");
  const target = targetFromPayload(payload);
  const workspaceId =
    typeof payload.workspace_id === "string" ? payload.workspace_id : target.workspace;

  if (!workspaceId) {
    sendJson(res, 400, { error: "missing workspace_id" });
    return;
  }

  log("rename received", {
    remoteAddress: req.socket.remoteAddress,
    workspaceId,
    hasTitle: typeof payload.title === "string",
    hasMessages: Array.isArray(payload.messages),
  });

  const result = await runCmuxAutoRename({
    workspaceId,
    title: typeof payload.title === "string" ? payload.title : "",
    messages: Array.isArray(payload.messages) ? payload.messages : undefined,
  });

  sendJson(res, 200, { ok: true, result });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== "POST" || (req.url !== "/notify" && req.url !== "/rename")) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  if (token && req.headers["x-cmux-notify-token"] !== token) {
    log("request unauthorized", { remoteAddress: req.socket.remoteAddress, path: req.url });
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  try {
    const rawBody = await readBody(req);
    if (req.url === "/rename") {
      await handleRename(req, res, rawBody);
    } else {
      await handleNotify(req, res, rawBody);
    }
  } catch (error) {
    log("request failed", { path: req.url, error: error.message });
    sendJson(res, 500, { error: error.message });
  }
});

server.on("error", (error) => {
  log("server error", { error: error.message, code: error.code });
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    log("signal received", { signal });
    process.exit(0);
  });
}

process.on("uncaughtException", (error) => {
  log("uncaught exception", { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  log("unhandled rejection", { error: message });
  process.exit(1);
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    log("server listening", { url: `http://${host}:${actualPort}` });
  });
}
