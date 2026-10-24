#!/usr/bin/env node
// install.mjs — the installer both shells call.
//
// Windows has no bash. Typing `bash install.sh` in cmd.exe only reaches the WSL
// launcher, which answers "Windows Subsystem for Linux has no installed
// distributions" — a message about WSL, when the user asked for an installer.
// install.bat is the Windows entry point and this file is what it runs; the work
// lives in the runtime the project already requires, so the two shells cannot
// drift apart and the Node test suite can drive the same path.
//
//   node bin/install.mjs --email you@example.com
//   node bin/install.mjs --status
//   node bin/install.mjs --start
//   node bin/install.mjs --stop
//
// Options mirror install.sh (see --help), with two deliberate differences:
//   * re-running keeps ARENA_AGENT_BRIDGE_KEY and STORAGE_ENCRYPTION_KEY unless
//     --key says otherwise. install.sh rotates the bearer key on every run,
//     which silently breaks every client already configured with it.
//   * only the answers given on this run are rewritten in DATA_DIR/.env; an
//     unmentioned ARENA_AGENT_PROXY is left alone. The browser is pinned to the
//     one this run actually found, like install.sh does.
//
// DATA_DIR/.env is written through writeSecretFile, so on Windows the icacls
// step that makes it owner-only happens before the keys are in the file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeSecretFile } from "../src/secret.mjs";
import { detectBrowser } from "../src/browser-detect.mjs";
import { VERSION } from "../src/version.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 20140;
const PID_FILE = "bridge.pid.json";
const KNOWN_INSECURE_STORAGE_KEY = "arena-bridge-local-key";

/** A failure the CLI reports as one line and turns into an exit code. */
export class InstallError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The retry pause between npm attempts, without an async step. */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ── options ─────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const options = {
    email: "",
    password: "",
    key: "",
    port: null,
    proxy: null, // null = not mentioned on this run; "" = clear it
    dataDir: "",
    chrome: "",
    noLogin: false,
    headed: false,
    noStart: false,
    noSelftest: false,
    start: false,
    stop: false,
    status: false,
    help: false,
  };
  const takeValue = (token, index) => {
    const equals = token.indexOf("=");
    if (equals > 0) return { value: token.slice(equals + 1), next: index };
    if (index + 1 >= argv.length) throw new InstallError(`${token} needs a value`, 2);
    return { value: argv[index + 1], next: index + 1 };
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const flag = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    switch (flag) {
      case "--email":
      case "-e": {
        const { value, next } = takeValue(token, index);
        options.email = value;
        index = next;
        break;
      }
      case "--password":
      case "-p": {
        const { value, next } = takeValue(token, index);
        options.password = value;
        index = next;
        break;
      }
      case "--key": {
        const { value, next } = takeValue(token, index);
        options.key = value;
        index = next;
        break;
      }
      case "--port": {
        const { value, next } = takeValue(token, index);
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new InstallError(`--port must be a number between 1 and 65535 (got ${JSON.stringify(value)})`, 2);
        }
        options.port = port;
        index = next;
        break;
      }
      case "--proxy": {
        const { value, next } = takeValue(token, index);
        options.proxy = value.trim();
        index = next;
        break;
      }
      case "--data-dir": {
        const { value, next } = takeValue(token, index);
        options.dataDir = value;
        index = next;
        break;
      }
      case "--chrome": {
        const { value, next } = takeValue(token, index);
        options.chrome = value;
        index = next;
        break;
      }
      case "--no-login":
        options.noLogin = true;
        break;
      case "--headed":
        options.headed = true;
        break;
      case "--no-start":
        options.noStart = true;
        break;
      case "--no-selftest":
        options.noSelftest = true;
        break;
      case "--start":
        options.start = true;
        break;
      case "--stop":
        options.stop = true;
        break;
      case "--status":
        options.status = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--warp":
        throw new InstallError(
          "--warp is a POSIX-only helper (warp.sh downloads a Linux wireproxy build). " +
            "On Windows, run Cloudflare WARP yourself and pass --proxy socks5://127.0.0.1:<port>.",
          2
        );
      default:
        throw new InstallError(`unknown argument: ${token}`, 2);
    }
  }
  return options;
}

/** `~` is a shell expansion; cmd.exe has none, so the installer has to do it. */
export function expandHome(value, homeDir = os.homedir()) {
  const text = String(value || "");
  if (text === "~") return homeDir;
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(homeDir, text.slice(2));
  return text;
}

export function resolveDataDir(options, env = process.env) {
  const raw = options.dataDir || env.DATA_DIR || path.join(os.homedir(), ".arena-bridge");
  return path.resolve(expandHome(String(raw)));
}

/** Parse DATA_DIR/.env well enough to preserve what this run does not touch. */
export function parseEnvFile(content) {
  const parsed = {};
  for (const rawLine of String(content || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!key) continue;
    parsed[key] = line.slice(equals + 1).trim().replace(/^["']|["']$/g, "");
  }
  return parsed;
}

/**
 * Rewrite the keys this run manages, keep everything else — comments included.
 * `updates` is ordered, and each entry is `{ key, value }`; an empty value
 * removes the key instead of writing `KEY=`.
 */
export function mergeEnvFile(existing, updates) {
  for (const { key, value } of updates) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new InstallError(`refusing to write an invalid .env key: ${key}`);
    if (/[\r\n\0]/.test(String(value))) throw new InstallError(`refusing to write a line break into ${key}`);
  }
  const managed = new Set(updates.map(({ key }) => key));
  const kept = [];
  for (const rawLine of String(existing || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=/.exec(rawLine);
    if (match && managed.has(match[1])) continue;
    kept.push(rawLine);
  }
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  for (const { key, value } of updates) {
    if (String(value) !== "") kept.push(`${key}=${value}`);
  }
  return `${kept.join("\n")}\n`;
}

function resolvePort(options, existingEnv) {
  if (options.port !== null) return options.port;
  const port = Number(existingEnv.PORT);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
}

function resolveBridgeKey(options, existingEnv) {
  const key = String(options.key || existingEnv.ARENA_AGENT_BRIDGE_KEY || "").trim();
  if (key) {
    if (/\s/.test(key)) throw new InstallError("--key must not contain whitespace", 2);
    return key;
  }
  return crypto.randomBytes(24).toString("hex");
}

function resolveStorageKey(existingEnv) {
  const secret = String(existingEnv.STORAGE_ENCRYPTION_KEY || "").trim();
  // The bridge refuses the old publicly known fallback (secret.mjs), so an
  // install that would leave it in place has to replace it.
  if (!secret || secret === KNOWN_INSECURE_STORAGE_KEY) return crypto.randomBytes(32).toString("hex");
  return secret;
}

// ── steps ───────────────────────────────────────────────────────────────────

function step(index, title) {
  console.log(`==> [${index}/7] ${title}`);
}
function detail(text) {
  console.log(`    ${text}`);
}
function warn(text) {
  console.error(`    WARN: ${text}`);
}

function readEnvFile(dataDir) {
  const file = path.join(dataDir, ".env");
  try {
    const content = fs.readFileSync(file, "utf8");
    return { file, content, values: parseEnvFile(content) };
  } catch (error) {
    if (error.code === "ENOENT") return { file, content: "", values: {} };
    throw new InstallError(`cannot read ${file}: ${error.message}`);
  }
}

function tail(file, lines = 20) {
  try {
    const content = fs.readFileSync(file, "utf8").replace(/\r/g, "").trimEnd();
    return content ? content.split("\n").slice(-lines).join("\n") : "";
  } catch {
    return "";
  }
}

function npmCommand() {
  // Avoid `.cmd` + shell: the npm CLI is a JS file next to the running Node.
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function runNpm(args, { cwd }) {
  const cli = npmCommand();
  if (cli) {
    return spawnSync(process.execPath, [cli, ...args], { cwd, stdio: "inherit", windowsHide: true });
  }
  // A Node build without npm beside it (some package managers). npm is a batch
  // file on Windows, so it needs a shell; none of these arguments comes from the
  // user, so there is nothing here for a shell to interpret.
  return spawnSync("npm", args, { cwd, stdio: "inherit", shell: process.platform === "win32", windowsHide: true });
}

function ensureDependencies({ root }) {
  const installed = path.join(root, "node_modules", "playwright", "package.json");
  if (fs.existsSync(installed)) {
    detail("playwright already installed");
    return;
  }
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = runNpm(["install", "playwright", "--no-audit", "--no-fund"], { cwd: root });
    if (!result.error && result.status === 0) return;
    lastError = result.error?.message || `npm exited with ${result.status}`;
    warn(`npm install failed (attempt ${attempt}/3): ${lastError}`);
    if (attempt < 3) sleepSync(3000);
  }
  throw new InstallError(
    `could not install the playwright dependency (${lastError}). ` +
      "Check the network/proxy, then run `npm install` in this folder."
  );
}

function installChromium({ root }) {
  const cli = path.join(root, "node_modules", "playwright", "cli.js");
  if (!fs.existsSync(cli)) {
    throw new InstallError("no Chromium-based browser found and the Playwright CLI is missing. Install Chrome or Edge, then retry.");
  }
  detail("no installed browser found; downloading Playwright's Chromium (about 150 MB)");
  const result = spawnSync(process.execPath, [cli, "install", "chromium"], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    timeout: 15 * 60 * 1000,
  });
  if (result.error || result.status !== 0) {
    throw new InstallError(
      "could not download Playwright's Chromium. Install Google Chrome or Microsoft Edge " +
        "(both are Chromium-based), or point at one with --chrome <path>."
    );
  }
}

function findBrowser({ chrome = "", requested = false } = {}) {
  if (chrome) {
    const chosen = path.resolve(expandHome(chrome));
    if (!fs.existsSync(chosen)) {
      if (requested) throw new InstallError(`--chrome does not exist: ${chosen}`);
      warn(`the browser configured in .env is missing: ${chosen}`);
    } else {
      return { path: chosen, configured: true };
    }
  }
  const { path: found, tried } = detectBrowser({ env: process.env });
  if (found) return { path: found, configured: false, tried };
  return { path: "", configured: false, tried };
}

/**
 * The browser this run should use:
 *   explicit --chrome : the user's choice
 *   .env entry        : reused; a path that no longer exists falls back to
 *                       detection (the file names a browser that is gone)
 *   detection         : what install.sh also writes into .env, so a later
 *                       `node src/index.mjs` finds the same one
 */
function chooseBrowser(options) {
  return findBrowser(options);
}

// ── the bridge process ──────────────────────────────────────────────────────

async function health(port, timeoutMs = 900) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload && payload.service === "arena-bridge" ? payload : null;
  } catch {
    return null;
  }
}

function pidPath(dataDir) {
  return path.join(dataDir, PID_FILE);
}

function readPidRecord(dataDir) {
  try {
    const record = JSON.parse(fs.readFileSync(pidPath(dataDir), "utf8"));
    return record && Number.isInteger(record.pid) && record.pid > 0 ? record : null;
  } catch {
    return null;
  }
}

function removePidRecord(dataDir) {
  fs.rmSync(pidPath(dataDir), { force: true });
}

function healthTimeoutMs() {
  const configured = Number(process.env.ARENA_INSTALL_HEALTH_TIMEOUT_MS || 60_000);
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 1_000), 600_000) : 60_000;
}

function stopTimeoutMs() {
  const configured = Number(process.env.ARENA_INSTALL_STOP_TIMEOUT_MS || 15_000);
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 500), 120_000) : 15_000;
}

/**
 * Stop a bridge this installer started. The instance marker in /health is what
 * makes it "this installer's": a PID can be reused, and another tool's bridge on
 * the same port must not be killed because our record happened to point at it.
 */
async function stopRecorded(record, { dataDir = record.dataDir, quiet = false } = {}) {
  const port = Number(record.port) || DEFAULT_PORT;
  const running = await health(port);
  if (!running) {
    removePidRecord(dataDir);
    if (!quiet) detail("the recorded bridge is no longer running (stale record removed)");
    return false;
  }
  // Every record this installer writes carries its instance. A record without
  // one is stale or hand-edited, and is not evidence of ownership.
  if (!record.instance || running.launcherInstance !== record.instance) {
    throw new InstallError(
      `a different arena-bridge is answering on http://127.0.0.1:${port} (instance mismatch). ` +
        "Not stopping it. Stop that one yourself, or start this install on another --port."
    );
  }
  if (!quiet) detail(`stopping the running bridge (pid ${record.pid})`);
  if (process.platform === "win32") {
    // TerminateProcess does not run the bridge's shutdown path, and the browser
    // it launched is a grandchild; /T is what keeps Chromium from being orphaned.
    const result = spawnSync("taskkill", ["/PID", String(record.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error) throw new InstallError(`could not stop pid ${record.pid}: ${result.error.message}`);
    if (result.status !== 0 && result.status !== 128) {
      warn(`taskkill exited with ${result.status}; verifying through /health`);
    }
  } else {
    try {
      process.kill(record.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw new InstallError(`could not stop pid ${record.pid}: ${error.message}`);
    }
  }
  const deadline = Date.now() + stopTimeoutMs();
  while (Date.now() < deadline) {
    if (!(await health(port))) break;
    await sleep(250);
  }
  if (await health(port)) {
    if (process.platform !== "win32") {
      try {
        process.kill(record.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await sleep(500);
    if (await health(port)) {
      throw new InstallError(
        `the bridge on port ${port} did not stop. Close it yourself and retry (pid ${record.pid}).`
      );
    }
  }
  removePidRecord(dataDir);
  return true;
}

async function startBridge({ root, dataDir, port, key, chrome, proxy, headed = false, env = process.env }) {
  const current = await health(port);
  if (current) {
    const record = readPidRecord(dataDir);
    if (!record || !record.instance || record.instance !== current.launcherInstance) {
      throw new InstallError(
        `something is already serving http://127.0.0.1:${port} and this installer did not start it.\n` +
          "    Stop it first (its own window or stop-gui.bat), or choose another --port.\n" +
          "    The installer never kills a process it cannot identify."
      );
    }
    detail(`replacing the bridge already running on port ${port}`);
    await stopRecorded(record, { dataDir });
  }

  const instance = `installer-${crypto.randomBytes(8).toString("hex")}`;
  const logFile = path.join(dataDir, "bridge.log");
  const entry = path.join(root, "src", "index.mjs");
  const childEnv = {
    ...env,
    DATA_DIR: dataDir,
    PORT: String(port),
    ARENA_AGENT_BRIDGE_KEY: key,
    ARENA_LAUNCHER_INSTANCE: instance,
  };
  if (chrome) childEnv.ARENA_AGENT_CHROME = chrome;
  if (proxy) childEnv.ARENA_AGENT_PROXY = proxy;
  if (headed) childEnv.ARENA_HEADED = "1";

  const logFd = fs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(process.execPath, [entry], {
      cwd: root,
      env: childEnv,
      // Detached: the bridge has to outlive the cmd/PowerShell window the
      // installer ran in. Its output goes to DATA_DIR/bridge.log instead of a
      // console that will close.
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.unref();
  fs.writeFileSync(
    pidPath(dataDir),
    JSON.stringify(
      {
        pid: child.pid,
        instance,
        port,
        dataDir,
        entry,
        version: VERSION,
        startedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  );
  return { child, instance, logFile, port };
}

async function waitForHealth({ child, instance, port, logFile }) {
  const deadline = Date.now() + healthTimeoutMs();
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new InstallError(
        `the bridge exited during startup (exit ${child.exitCode}). Last lines of ${logFile}:\n` +
          indent(tail(logFile))
      );
    }
    const payload = await health(port);
    if (payload && payload.launcherInstance === instance) return payload;
    await sleep(500);
  }
  const payload = await health(port);
  if (payload && payload.launcherInstance === instance) return payload;
  throw new InstallError(
    `the bridge did not become healthy within ${Math.round(healthTimeoutMs() / 1000)}s. ` +
      `Last lines of ${logFile}:\n${indent(tail(logFile))}`
  );
}

function indent(text, prefix = "    ") {
  if (!text) return `${prefix}(the log is empty)`;
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

// ── login ───────────────────────────────────────────────────────────────────

/**
 * Ask for the password without echoing it.
 *
 * readline's question() prints every key, so the old prompt put the user's
 * password on screen — and from there into any screenshot, screen share or
 * pasted transcript of the session. A terminal can hide input; this does it by
 * putting stdin in raw mode and writing one '*' per character.
 *
 * Exported so the non-interactive refusal can be tested without a terminal.
 */
export async function promptPassword(email, { stdin = process.stdin, stderr = process.stderr } = {}) {
  if (!stdin.isTTY) {
    throw new InstallError(
      `no password for ${email} and stdin is not interactive. Pass --password, or set ARENA_PASSWORD.`,
      1
    );
  }
  stderr.write(`Password for ${email}: `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return await new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      stdin.removeListener("data", onData);
      // Hand the terminal back the way it was found: cooked mode, no read.
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n" || character === "\u0004") {
          // \u0004 is Ctrl-Z on Windows: an empty answer is still an answer.
          return finish();
        }
        if (character === "\u0003") return finish(new InstallError("cancelled (Ctrl-C)", 130));
        if (character === "\u007f" || character === "\b") {
          if (value) {
            value = value.slice(0, -1);
            stderr.write("\b \b");
          }
          continue;
        }
        // Arrow keys and the like arrive as ESC sequences; do not let them
        // become part of the password.
        if (character === "\u001b" || character < " ") continue;
        value += character;
        stderr.write("*");
      }
      return undefined;
    };
    stdin.on("data", onData);
  });
}

async function login({ root, dataDir, key, email, password, chrome, proxy, headed = false, env = process.env }) {
  if (!email) {
    throw new InstallError(
      "no email. Pass --email you@example.com (or set ARENA_EMAIL), or use --no-login to skip signing in."
    );
  }
  const secret = password || (await promptPassword(email));
  if (!secret) throw new InstallError("the password is empty", 1);
  const childEnv = {
    ...env,
    DATA_DIR: dataDir,
    ARENA_AGENT_BRIDGE_KEY: key,
    // Through the environment, never argv: a command line is visible to every
    // process on this machine, and this one carries a password.
    ARENA_PASSWORD: secret,
  };
  if (chrome) childEnv.ARENA_AGENT_CHROME = chrome;
  if (proxy) childEnv.ARENA_AGENT_PROXY = proxy;
  if (headed) childEnv.ARENA_HEADED = "1";
  detail(`signing in as ${email}${headed ? " (headed: watch the browser)" : ""}`);
  const result = spawnSync(process.execPath, [path.join(root, "bin", "login.mjs"), "--email", email], {
    cwd: root,
    env: childEnv,
    stdio: "inherit",
  });
  if (result.error) throw new InstallError(`could not run bin/login.mjs: ${result.error.message}`);
  if (result.status !== 0) {
    // The two failures need different reactions, so do not collapse them into
    // one sentence. The child already printed Arena's own answer above.
    throw new InstallError(
      [
        `Arena login failed (exit ${result.status}).`,
        "",
        "  Invalid email or password (401)  -> the password for that address is wrong.",
        "                                     Check the exact email, then retry.",
        "  session is not usable            -> Arena accepted the password but served the",
        "                                     account as logged out. A new session is",
        "                                     stored anyway; the bridge reports the account",
        "                                     as not ready instead of pretending it works.",
        "  no Chromium-based browser        -> install Chrome or Edge, or pass --chrome <path>.",
        "",
        headed
          ? "The browser window is still open; close it once you have read the page."
          : "Add --headed to watch the sign-in in a real browser window.",
      ].join("\n")
    );
  }
}

// ── self-test ───────────────────────────────────────────────────────────────

function runSelftest({ root, dataDir, key, chrome, proxy, headed = false, env = process.env }) {
  const childEnv = { ...env, DATA_DIR: dataDir, ARENA_AGENT_BRIDGE_KEY: key };
  if (chrome) childEnv.ARENA_AGENT_CHROME = chrome;
  if (proxy) childEnv.ARENA_AGENT_PROXY = proxy;
  if (headed) childEnv.ARENA_HEADED = "1";
  const result = spawnSync(process.execPath, [path.join(root, "bin", "selftest.mjs")], {
    cwd: root,
    env: childEnv,
    stdio: "inherit",
    timeout: 15 * 60 * 1000,
  });
  if (result.error) {
    warn(`self-test could not run: ${result.error.message}`);
    return "FAIL";
  }
  if (result.status === 0) return "PASS";
  if (result.status === 2) return "PARTIAL";
  return "FAIL";
}

/** Start, then wait. A bridge that never becomes healthy is torn down again so
 *  the next run is not blocked by a half-started process on the same port. */
async function startAndWait({ dataDir, port, key, chrome, proxy, headed = false }) {
  const started = await startBridge({ root: ROOT, dataDir, port, key, chrome, proxy, headed });
  try {
    const payload = await waitForHealth(started);
    return { started, payload };
  } catch (error) {
    const record = readPidRecord(dataDir) || {
      pid: started.child.pid,
      instance: started.instance,
      port,
      dataDir,
    };
    await stopRecorded(record, { dataDir, quiet: true }).catch(() => undefined);
    throw error;
  }
}

// ── the commands ────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`arena-bridge installer ${VERSION}

Usage:
  node bin/install.mjs [options]        (all platforms)
  install.bat [options]                 (Windows, no WSL needed)
  bash install.sh [options]             (macOS / Linux / WSL / Git Bash)

Options:
  --email <email>       Arena account email (or ARENA_EMAIL)
  --password <pass>     Arena password (or ARENA_PASSWORD; prompted when absent).
                        Prefer the prompt: it does not echo, and a password in
                        argv is visible to other processes on this machine.
  --key <hex>           Bearer key for the local API (kept from .env when omitted)
  --port <n>            Local HTTP port (default 20140, or the .env value)
  --proxy <url>         Browser proxy, e.g. socks5://127.0.0.1:40000
  --data-dir <dir>      State directory (default ~/.arena-bridge)
  --chrome <path>       Chromium-based browser to use
  --headed              Show the browser instead of running it headless. Useful
                        for the first sign-in, and for a sign-in that Arena
                        refuses: you can see what the page actually does.
  --no-login            Install and write .env only; do not sign in or start
  --no-start            Sign in, but do not start the bridge
  --no-selftest         Skip the end-to-end Arena self-test
  --start               Start the bridge with the saved account
  --stop                Stop the bridge this installer started
  --status              Show whether that bridge is running
  --help                This text

Environment: ARENA_EMAIL, ARENA_PASSWORD, DATA_DIR, ARENA_AGENT_CHROME,
ARENA_AGENT_PROXY, ARENA_NODE_PATH (Windows bootstrap), and
ARENA_INSTALL_HEALTH_TIMEOUT_MS for slow machines.`);
}

async function statusCommand(options) {
  const dataDir = resolveDataDir(options);
  const record = readPidRecord(dataDir);
  const envValues = readEnvFile(dataDir).values;
  const port = options.port ?? (Number(record?.port) || Number(envValues.PORT) || DEFAULT_PORT);
  const running = await health(port);
  console.log(`data dir : ${dataDir}`);
  console.log(`port     : ${port}`);
  console.log(`pid file : ${record ? `pid ${record.pid} (instance ${record.instance || "unknown"})` : "none"}`);
  if (!running) {
    console.log(`bridge   : not answering on http://127.0.0.1:${port}/`);
    return 1;
  }
  console.log(`bridge   : running on http://127.0.0.1:${port}/`);
  console.log(`instance : ${running.launcherInstance || "(not recorded by this installer)"}`);
  console.log(`ready    : ${running.ready ? "yes" : "no usable account yet"}`);
  console.log(`accounts : ${Array.isArray(running.accounts) ? running.accounts.length : 0}`);
  if (record && running.launcherInstance && record.instance && running.launcherInstance !== record.instance) {
    console.log("note     : the bridge on this port was NOT started by this installer");
  }
  return 0;
}

async function stopCommand(options) {
  const dataDir = resolveDataDir(options);
  const record = readPidRecord(dataDir);
  if (!record) {
    const envValues = readEnvFile(dataDir).values;
    const port = options.port ?? (Number(envValues.PORT) || DEFAULT_PORT);
    const running = await health(port);
    if (running) {
      throw new InstallError(
        `an arena-bridge is answering on http://127.0.0.1:${port}, but there is no record in ${dataDir} ` +
          "showing this installer started it. Not stopping it; use the mechanism that started it " +
          "(stop-gui.bat for the portable release, or close its console)."
      );
    }
    console.log("No bridge started by this installer is running.");
    return 0;
  }
  const stopped = await stopRecorded(record);
  console.log(stopped ? `Stopped the arena-bridge started by this installer (pid ${record.pid}).` : "The recorded bridge was already gone.");
  return 0;
}

async function installCommand(options) {
  if (options.start) return startCommand(options);

  console.log(`arena-bridge installer ${VERSION}${process.platform === "win32" ? " (Windows)" : ""}`);
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new InstallError(`Node.js 20 or newer is required (this is ${process.version}).`);

  const dataDir = resolveDataDir(options);
  const env = readEnvFile(dataDir);
  const port = resolvePort(options, env.values);
  const key = resolveBridgeKey(options, env.values);
  const storageKey = resolveStorageKey(env.values);
  const proxy = options.proxy === null ? String(env.values.ARENA_AGENT_PROXY || "") : options.proxy;

  step(1, "Node.js check");
  detail(`node ${process.version}`);

  step(2, "Dependencies and a Chromium-based browser");
  ensureDependencies({ root: ROOT });
  let browser = chooseBrowser({
    chrome: options.chrome || String(env.values.ARENA_AGENT_CHROME || ""),
    requested: Boolean(options.chrome),
  });
  if (!browser.path) {
    installChromium({ root: ROOT });
    browser = chooseBrowser({
      chrome: options.chrome || String(env.values.ARENA_AGENT_CHROME || ""),
      requested: Boolean(options.chrome),
    });
  }
  if (!browser.path) {
    const tried = browser.tried?.length ? `\n    Looked for:\n${indent(browser.tried.join("\n"), "      ")}` : "";
    throw new InstallError(
      "no Chromium-based browser found. Install Google Chrome or Microsoft Edge, " +
        "then run the installer again (or pass --chrome <path>)." +
        tried
    );
  }
  detail(`browser: ${browser.path}`);
  // install.sh pins the browser it found into .env, so a later manual start
  // finds the same one instead of searching again.
  const chrome = browser.path;

  step(3, `Data directory and .env (${dataDir})`);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const updates = [
    { key: "PORT", value: String(port) },
    { key: "ARENA_AGENT_PROXY", value: proxy },
    { key: "ARENA_AGENT_CHROME", value: chrome },
    { key: "ARENA_AGENT_BRIDGE_KEY", value: key },
    { key: "DATA_DIR", value: dataDir },
    { key: "STORAGE_ENCRYPTION_KEY", value: storageKey },
  ];
  const envContent = mergeEnvFile(env.content, updates);
  writeSecretFile(env.file, envContent);
  detail(`wrote ${env.file} (owner-only)`);

  if (options.noLogin) {
    printNoLoginSummary({ dataDir, envFile: env.file, key, port });
    return 0;
  }

  step(4, "Sign in to arena.ai with your own account");
  await login({
    root: ROOT,
    dataDir,
    key,
    email: String(options.email || process.env.ARENA_EMAIL || "").trim(),
    password: String(options.password || process.env.ARENA_PASSWORD || ""),
    chrome,
    proxy,
    headed: options.headed,
  });

  if (options.noStart) {
    step(5, "Start bridge");
    detail("--no-start: not starting the bridge.");
    printStartSummary({ dataDir, envFile: env.file, key, port, selftest: "", running: false });
    return 0;
  }

  step(5, "Start bridge");
  const { started, payload } = await startAndWait({ dataDir, port, key, chrome, proxy, headed: options.headed });

  step(6, "Wait for health");
  detail(`healthy on http://127.0.0.1:${port} (pid ${payload.pid ?? started.child.pid})`);
  detail(`log: ${started.logFile}`);

  let selftest = "";
  if (options.noSelftest) {
    step(7, "Self-test");
    detail("--no-selftest: skipped");
  } else {
    step(7, "Self-test (a real turn against Arena)");
    selftest = runSelftest({ root: ROOT, dataDir, key, chrome, proxy, headed: options.headed });
  }

  printStartSummary({ dataDir, envFile: env.file, key, port, selftest });
  return 0;
}

/** `--start`: the bridge after a reboot, with the account already stored. */
async function startCommand(options) {
  const dataDir = resolveDataDir(options);
  const env = readEnvFile(dataDir);
  if (!env.values.ARENA_AGENT_BRIDGE_KEY) {
    throw new InstallError(`no ARENA_AGENT_BRIDGE_KEY in ${env.file}. Run the installer with --email first.`);
  }
  const port = resolvePort(options, env.values);
  const key = env.values.ARENA_AGENT_BRIDGE_KEY;
  const proxy = options.proxy === null ? String(env.values.ARENA_AGENT_PROXY || "") : options.proxy;

  step(1, "Node.js check");
  detail(`node ${process.version}`);
  step(2, "Dependencies and a Chromium-based browser");
  ensureDependencies({ root: ROOT });
  // No .env rewrite on a control command: the value is handed to the child,
  // which is enough for this start.
  const chrome = chooseBrowser({
    chrome: options.chrome || String(env.values.ARENA_AGENT_CHROME || ""),
    requested: Boolean(options.chrome),
  }).path;
  if (!chrome) {
    throw new InstallError("no Chromium-based browser found. Install Google Chrome or Microsoft Edge, then retry.");
  }
  detail(`browser: ${chrome}`);
  step(3, `Data directory (${dataDir})`);
  detail("using the saved account");
  step(4, "Sign in to arena.ai with your own account");
  detail("--start: skipped; the saved account is reused");
  step(5, "Start bridge");
  const { started, payload } = await startAndWait({ dataDir, port, key, chrome, proxy, headed: options.headed });
  step(6, "Wait for health");
  detail(`healthy on http://127.0.0.1:${port} (pid ${payload.pid ?? started.child.pid})`);
  detail(`log: ${started.logFile}`);
  step(7, "Self-test");
  detail("--start: skipped (run `node bin/selftest.mjs` for a real turn)");
  printStartSummary({ dataDir, envFile: env.file, key, port, selftest: "" });
  return 0;
}

function printNoLoginSummary({ dataDir, envFile, key, port }) {
  console.log("");
  console.log("===============================================================");
  console.log(` arena-bridge ${VERSION} installed (no sign-in yet).`);
  console.log(` Data dir   : ${dataDir}`);
  console.log(` Bridge key : ${key}`);
  console.log(` Env file   : ${envFile}`);
  console.log("---------------------------------------------------------------");
  console.log(" Sign in:    node bin/install.mjs --email <email>");
  console.log(` Start:      node bin/install.mjs --start     (http://127.0.0.1:${port}/)`);
  console.log(" Windows:    install.bat --email <email>  /  install.bat --start");
  console.log("===============================================================");
}

function printStartSummary({ dataDir, envFile, key, port, selftest, running = true }) {
  const base = `http://127.0.0.1:${port}`;
  console.log("");
  console.log("===============================================================");
  console.log(
    running
      ? ` arena-bridge ${VERSION} is UP on ${base}`
      : ` arena-bridge ${VERSION} installed (not started)`
  );
  console.log(` Bridge key : ${key}   (also stored in ${envFile})`);
  console.log(` Data dir   : ${dataDir}`);
  if (selftest) {
    console.log(
      ` Self-test  : ${
        selftest === "PASS" ? "PASS" : selftest === "PARTIAL" ? "PARTIAL (turn works; answer differed)" : "FAIL (see above)"
      }`
    );
  }
  console.log("---------------------------------------------------------------");
  console.log(" GUI:");
  console.log(`   ${base}/`);
  console.log(" Chat:");
  console.log(`   curl -X POST ${base}/v1/chat/completions \\`);
  console.log(`     -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\`);
  console.log(`     -d '{"model":"agent","messages":[{"role":"user","content":"Hello"}]}'`);
  console.log(" Status / start / stop:");
  console.log("   node bin/install.mjs --status       (Windows: install.bat --status)");
  if (!running) console.log("   node bin/install.mjs --start        (Windows: install.bat --start)");
  console.log("   node bin/install.mjs --stop         (Windows: install.bat --stop)");
  console.log("===============================================================");
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      printHelp();
      return 0;
    }
    if (options.stop) return await stopCommand(options);
    if (options.status) return await statusCommand(options);
    return await installCommand(options);
  } catch (error) {
    if (error instanceof InstallError) {
      console.error(`ERROR: ${error.message}`);
      if (error.exitCode === 2) console.error("Run `node bin/install.mjs --help` for the options.");
      return error.exitCode;
    }
    console.error(`ERROR: ${error?.message || error}`);
    if (process.env.ARENA_DEBUG === "1") console.error(error?.stack);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}
