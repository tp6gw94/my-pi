import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nonempty } from "./domain.mjs";

const exec = promisify(execFile);

export function shellQuote(value) {
  if (String(value).includes("\0")) throw new Error("Shell argument contains NUL");
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function viewerCommand({ nodePath = process.execPath, viewerPath, eventFile }) {
  return [nodePath, viewerPath, "--events", eventFile].map(shellQuote).join(" ");
}

export function splitDirection(geometry) {
  const width = Number(geometry?.width);
  const height = Number(geometry?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("Herdr caller pane geometry is unavailable");
  return width >= height * 3 ? "right" : "down";
}

export function parsePaneId(response) {
  const data = response?.result ?? response;
  const pane = data?.pane ?? data;
  const id = pane?.pane_id ?? pane?.paneId ?? pane?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function currentPaneSplitArguments({ callerPaneId, direction, cwd }, savedEnv, currentEnv = process.env) {
  if (savedEnv.HERDR_ENV !== "1" || currentEnv.HERDR_ENV !== "1" || !savedEnv.HERDR_PANE_ID || savedEnv.HERDR_PANE_ID !== callerPaneId || currentEnv.HERDR_PANE_ID !== callerPaneId) {
    throw new Error("Verified Herdr --current split requires the unchanged originating HERDR_PANE_ID.");
  }
  return ["pane", "split", "--current", "--direction", direction, "--cwd", cwd, "--no-focus"];
}

export function layoutGeometry(layout, paneId) {
  const data = layout?.result ?? layout;
  const current = data?.layout ?? data;
  const panes = Array.isArray(current?.panes) ? current.panes : [current?.pane ?? current];
  const pane = panes.find((item) => parsePaneId(item) === paneId);
  const geometry = pane?.rect ?? pane?.geometry;
  if (!geometry || !Number.isFinite(geometry.width) || !Number.isFinite(geometry.height)) return undefined;
  return { width: geometry.width, height: geometry.height };
}

export function createHerdrCliAdapter({ binary = process.env.HERDR_BIN ?? "herdr", run = exec,
  env = { ...process.env }, currentEnv = () => process.env, geometryFromLayout = layoutGeometry } = {}) {
  async function command(args, allowEmpty = false) {
    const { stdout } = await run(binary, args, { shell: false, timeout: 15000, maxBuffer: 1048576 });
    const text = stdout.trim();
    if (allowEmpty && !text) return;
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Herdr response must be a JSON object");
    if (value.error) {
      const error = new Error(value.error.message ?? "Herdr command failed");
      error.code = value.error.code;
      throw error;
    }
    return value.result ?? value;
  }
  return {
    async inspect(paneId) {
      let pane;
      try { pane = await command(["pane", "get", paneId]); }
      catch (error) { if (/not[_-]?found|pane[_-]?gone|no_such_pane/i.test(String(error.code))) return undefined; throw error; }
      const id = parsePaneId(pane);
      if (!id) throw new Error("Herdr pane get response contains no pane ID");
      if (id !== paneId) return undefined;
      const layout = await command(["pane", "layout", "--pane", paneId]);
      const geometry = geometryFromLayout(layout, paneId);
      if (!geometry) throw new Error("Herdr pane layout response contains no pane geometry");
      return { paneId: id, geometry };
    },
    async create({ callerPaneId, direction, cwd }) {
      const pane = await command(currentPaneSplitArguments({ callerPaneId, direction, cwd }, env, currentEnv()));
      if (!parsePaneId(pane)) throw new Error("Herdr creation response contains no pane ID");
      return pane;
    },
    async run(paneId, shellCommand) { return command(["pane", "run", paneId, shellCommand], true); },
    async close(paneId) { return command(["pane", "close", paneId], true); },
  };
}

export class HerdrOpener {
  constructor({ adapter, viewerPath, env = process.env }) {
    Object.assign(this, { adapter, viewerPath, env: { ...env } });
    this.bindings = new Map();
    this.pending = new Map();
  }
  open(task, { callerPaneId, direction } = {}) {
    if (this.pending.has(task.taskId)) return this.pending.get(task.taskId);
    const opening = this.openPane(task, { callerPaneId, direction });
    this.pending.set(task.taskId, opening);
    opening.finally(() => this.pending.delete(task.taskId)).catch(() => {});
    return opening;
  }
  async openPane(task, { callerPaneId, direction }) {
    if (this.env.HERDR_ENV !== "1") throw new Error("Herdr viewer requires HERDR_ENV=1");
    nonempty(callerPaneId, "callerPaneId", 256);
    const command = viewerCommand({ viewerPath: this.viewerPath, eventFile: task.eventFile });
    const binding = this.bindings.get(task.taskId);
    if (binding) {
      let live;
      try { live = await this.adapter.inspect(binding.paneId); }
      catch (error) {
        if (binding.launchError) throw new Error(`${binding.launchError.message}; owned pane inspection failed: ${error.message}`);
        throw error;
      }
      if (live?.paneId === binding.paneId) {
        if (binding.launchError) throw binding.launchError;
        return { taskId: task.taskId, paneId: binding.paneId, reused: true, command };
      }
      this.bindings.delete(task.taskId);
    }
    const caller = await this.adapter.inspect(callerPaneId);
    if (caller?.paneId !== callerPaneId) throw new Error("Explicit caller Herdr pane no longer exists");
    const placement = direction ?? splitDirection(caller.geometry);
    if (!["right", "down"].includes(placement)) throw new Error("Viewer direction must be right or down");
    const created = await this.adapter.create({ callerPaneId, direction: placement, cwd: task.cwd, focus: false });
    const paneId = parsePaneId(created);
    if (!paneId) throw new Error("Herdr creation response contains no pane ID");
    if (paneId === callerPaneId || [...this.bindings.values()].some((item) => item.paneId === paneId)) throw new Error("Herdr creation returned a caller or already-bound pane ID");
    const owned = { paneId, callerPaneId, taskId: task.taskId };
    this.bindings.set(task.taskId, owned);
    try { await this.adapter.run(paneId, command); }
    catch (error) {
      const message = `Viewer launch acknowledgement failed in extension-created pane ${paneId}: ${error.message}`;
      try { await this.adapter.close(paneId); }
      catch (cleanupError) {
        owned.launchError = new Error(`${message}; cleanup failed: ${cleanupError.message}. Viewer start is unconfirmed; owned pane ${paneId} is retained. Close it before retrying.`);
        throw owned.launchError;
      }
      this.bindings.delete(task.taskId);
      throw new Error(`${message}; created pane was closed`);
    }
    return { taskId: task.taskId, paneId, reused: false, command };
  }
}
