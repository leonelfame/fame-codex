const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_MODELS = 256;

function boundedTimeout(value, fallback) {
  const timeout = value ?? fallback;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000) {
    throw new Error("AiPASS timeout must be between 1 and 30000 milliseconds");
  }
  return timeout;
}

function childEnvironment(environment, port) {
  const result = {};
  for (const [key, value] of Object.entries(environment)) {
    if (/^AIPASS_/i.test(key) || /^(NODE_OPTIONS|NODE_PATH|BUN_OPTIONS)$/i.test(key)) continue;
    if (value !== undefined) result[key] = value;
  }
  return Object.assign(result, {
    AIPASS_HOST: "127.0.0.1",
    AIPASS_PORT: String(port),
    AIPASS_ADMIN: "0",
    AIPASS_CORS_ORIGIN: "",
    AIPASS_MODELS: "",
    AIPASS_MODEL_FILTER: "chat",
  });
}

function portAvailable(port, timeoutMs) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const timer = setTimeout(() => finish(false), timeoutMs);
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (server.listening) server.close(() => resolve(available));
      else resolve(available);
    };
    server.once("error", () => finish(false));
    server.once("listening", () => {
      if (settled) server.close();
      else finish(true);
    });
    server.listen({ port, host: "127.0.0.1", exclusive: true });
  });
}

function requestJson(port, pathname, timeoutMs) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const request = http.get({
      hostname: "127.0.0.1", port, path: pathname, agent: false,
      headers: { accept: "application/json" },
    }, (response) => {
      if (response.statusCode !== 200) {
        request.destroy(new Error("http_status"));
        return;
      }
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) request.destroy(new Error("response_too_large"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("invalid_json")); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error("request_timeout")), timeoutMs);
    request.once("error", reject);
    request.once("close", () => clearTimeout(timer));
  });
}

function modelsFromResponse(value) {
  if (!value || value.object !== "list" || !Array.isArray(value.data) || value.data.length > MAX_MODELS) {
    throw new Error("invalid_models");
  }
  const models = new Map();
  for (const row of value.data) {
    if (!row || !["chat", "text"].includes(row.kind)
      || row.fallback === true || row.source === "fallback"
      || row.ready === false || row.selectable === false
      || typeof row.id !== "string" || !row.id.trim() || row.id.length > 256
      || /[\x00-\x1f\x7f]/.test(row.id)) continue;
    const name = typeof row.name === "string" && row.name.trim()
      ? row.name.slice(0, 256).replace(/[\x00-\x1f\x7f]/g, "") : row.id;
    if (!models.has(row.id)) models.set(row.id, { id: row.id, name, kind: row.kind });
  }
  return [...models.values()];
}

class AiPassController {
  constructor({
    enabled = false, runtimeExecutable, scriptPath, port = 17843,
    env = process.env, spawnProcess = spawn,
    requestTimeoutMs, modelTimeoutMs, startTimeoutMs, stopTimeoutMs,
  } = {}) {
    if (typeof enabled !== "boolean") throw new Error("AiPASS enabled must be a boolean");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid AiPASS port");
    if (enabled && (!path.isAbsolute(runtimeExecutable ?? "") || !path.isAbsolute(scriptPath ?? ""))) {
      throw new Error("AiPASS requires absolute runtimeExecutable and scriptPath");
    }
    this.enabled = enabled;
    this.runtimeExecutable = runtimeExecutable;
    this.scriptPath = scriptPath;
    this.port = port;
    this.environment = childEnvironment(env, port);
    this.spawnProcess = spawnProcess;
    this.requestTimeoutMs = boundedTimeout(requestTimeoutMs, 1500);
    this.modelTimeoutMs = boundedTimeout(modelTimeoutMs, requestTimeoutMs ?? 25_000);
    this.startTimeoutMs = boundedTimeout(startTimeoutMs, 5000);
    this.stopTimeoutMs = boundedTimeout(stopTimeoutMs, 2000);
    this.owned = null;
    this.queue = Promise.resolve();
    this.state = {
      enabled, status: enabled ? "stopped" : "disabled", port,
      extensionConnected: false, models: [], error: null,
    };
  }

  snapshot() {
    return { ...this.state, models: this.state.models.map(model => ({ ...model })) };
  }

  start() { return this.enqueue(() => this.startOwned()); }
  stop() { return this.enqueue(() => this.stopOwned()); }
  refresh() { return this.enqueue(() => this.refreshOwned()); }

  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  owns(record) {
    return record !== null && this.owned === record && !record.exited
      && Number.isInteger(record.pid) && record.pid > 0 && record.child.pid === record.pid
      && record.child.exitCode === null && record.child.signalCode === null;
  }

  fail(error) {
    this.state = { ...this.state, status: "error", extensionConnected: false, models: [], error };
    return this.snapshot();
  }

  async startOwned() {
    if (!this.enabled) return this.snapshot();
    if (this.owns(this.owned)) return this.refreshOwned();
    if (this.owned) return this.fail("ownership_lost");
    this.state = { ...this.state, status: "starting", error: null, models: [], extensionConnected: false };
    if (!await portAvailable(this.port, this.requestTimeoutMs)) return this.fail("port_unavailable");
    let child;
    try {
      child = this.spawnProcess(this.runtimeExecutable, [this.scriptPath], {
        env: { ...this.environment }, stdio: "ignore", shell: false, windowsHide: true,
      });
    } catch { return this.fail("spawn_failed"); }
    const record = { child, pid: child.pid, exited: false, stopping: false, spawnError: false };
    this.owned = record;
    record.exit = new Promise((resolve) => {
      child.once("exit", () => {
        record.exited = true;
        if (this.owned === record) {
          this.owned = null;
          if (!record.stopping) this.fail("child_exited");
        }
        resolve();
      });
      child.on("error", () => {
        record.spawnError = true;
        if (!record.pid) {
          record.exited = true;
          if (this.owned === record) this.owned = null;
          resolve();
        }
      });
    });
    // Failed executable launches report asynchronously, even when pid is absent.
    await new Promise(resolve => setImmediate(resolve));
    const deadline = Date.now() + this.startTimeoutMs;
    while (this.owns(record) && !record.spawnError && Date.now() < deadline) {
      try {
        const health = await requestJson(this.port, "/health", Math.max(1, Math.min(this.requestTimeoutMs, deadline - Date.now())));
        if (health?.ok === true && Number.isInteger(health.extensions) && health.extensions >= 0 && this.owns(record)) {
          return this.refreshOwned(health);
        }
      } catch { /* The child may not have bound its listener yet. */ }
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
    }
    const error = record.spawnError ? "spawn_failed" : record.exited ? "child_exited" : "start_timeout";
    if (this.owns(record)) {
      const stopped = await this.stopOwned();
      if (stopped.error) return stopped;
    }
    return this.fail(error);
  }

  async refreshOwned(initialHealth) {
    const record = this.owned;
    if (!this.owns(record)) return this.snapshot();
    try {
      const health = initialHealth ?? await requestJson(this.port, "/health", this.requestTimeoutMs);
      if (health?.ok !== true || !Number.isInteger(health.extensions) || health.extensions < 0) {
        return this.fail("invalid_health");
      }
      if (!this.owns(record)) return this.snapshot();
      this.state = { ...this.state, status: "running", extensionConnected: health.extensions > 0, models: [], error: null };
      if (health.extensions > 0) {
        const models = modelsFromResponse(await requestJson(this.port, "/v1/models?refresh=1", this.modelTimeoutMs));
        if (!this.owns(record)) return this.snapshot();
        // Do not publish a catalog if the extension disconnected during the loader read.
        const after = await requestJson(this.port, "/health", this.requestTimeoutMs);
        if (after?.ok !== true || !Number.isInteger(after.extensions) || after.extensions < 0) {
          return this.fail("invalid_health");
        }
        if (!this.owns(record)) return this.snapshot();
        this.state = { ...this.state, extensionConnected: after.extensions > 0, models: after.extensions > 0 ? models : [] };
      }
      return this.snapshot();
    } catch {
      if (!this.owns(record)) return this.snapshot();
      return this.fail("refresh_failed");
    }
  }

  async stopOwned() {
    const record = this.owned;
    if (record && !this.owns(record)) return this.fail("ownership_lost");
    if (record) {
      record.stopping = true;
      this.state = { ...this.state, status: "stopping", extensionConnected: false, models: [], error: null };
      // Only the retained spawn handle is signalled, never a PID discovered by port/health.
      for (const signal of ["SIGTERM", "SIGKILL"]) {
        if (!this.owns(record)) break;
        try { record.child.kill(signal); }
        catch { return this.fail("stop_failed"); }
        let timer;
        await Promise.race([
          record.exit,
          new Promise(resolve => { timer = setTimeout(resolve, this.stopTimeoutMs); }),
        ]);
        clearTimeout(timer);
      }
      if (this.owns(record)) return this.fail("stop_timeout");
      if (this.owned === record) return this.fail("ownership_lost");
    }
    this.state = { ...this.state, status: this.enabled ? "stopped" : "disabled", extensionConnected: false, models: [], error: null };
    return this.snapshot();
  }
}

module.exports = { AiPassController };
