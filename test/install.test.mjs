// The Windows install path: `bash install.sh` cannot run in cmd.exe, so
// install.bat hands the same options to bin/install.mjs. These tests drive that
// file end to end against disposable fixtures — a fake login, a fake bridge and
// a fake self-test — because the parts worth pinning down are the decisions:
// what lands in .env, what is passed on the command line, which process may be
// stopped, and what happens when a run fails halfway.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, mergeEnvFile, parseEnvFile, promptPassword, InstallError } from "../bin/install.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function until(check, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  return null;
}

/**
 * A disposable project tree. Only the files bin/install.mjs imports are real;
 * login, selftest and the bridge are fixtures that record what they were given.
 * `node_modules/playwright/package.json` exists so the dependency step is a
 * no-op — these tests must not reach the network.
 */
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arena-install-"));
  const home = path.join(root, "home");
  const browser = path.join(root, "fixture browser", "chrome.exe");
  const events = path.join(root, "events.jsonl");
  const boots = path.join(root, "boots.jsonl");
  const stops = path.join(root, "stops.jsonl");
  for (const dir of ["bin", "src", "node_modules/playwright", home]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.mkdirSync(path.dirname(browser), { recursive: true });
  fs.writeFileSync(browser, "fixture browser");
  fs.copyFileSync(new URL("../bin/install.mjs", import.meta.url), path.join(root, "bin/install.mjs"));
  fs.copyFileSync(new URL("../src/secret.mjs", import.meta.url), path.join(root, "src/secret.mjs"));
  fs.copyFileSync(new URL("../src/browser-detect.mjs", import.meta.url), path.join(root, "src/browser-detect.mjs"));
  fs.copyFileSync(new URL("../src/version.mjs", import.meta.url), path.join(root, "src/version.mjs"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "arena-install-fixture", version: "0.0.0-fixture" }));
  fs.writeFileSync(
    path.join(root, "node_modules/playwright/package.json"),
    JSON.stringify({ name: "playwright", version: "fixture" })
  );

  fs.writeFileSync(
    path.join(root, "bin/login.mjs"),
    `import fs from "node:fs";
    fs.appendFileSync(process.env.FIXTURE_LOGIN_EVENTS, JSON.stringify({
      argv: process.argv.slice(2),
      password: process.env.ARENA_PASSWORD || "",
      key: process.env.ARENA_AGENT_BRIDGE_KEY || "",
      dataDir: process.env.DATA_DIR || "",
      chrome: process.env.ARENA_AGENT_CHROME || "",
      headed: process.env.ARENA_HEADED || "",
    }) + "\\n");
    process.exit(Number(process.env.FIXTURE_LOGIN_EXIT || 0));
  `
  );

  fs.writeFileSync(
    path.join(root, "bin/selftest.mjs"),
    `import fs from "node:fs";
    fs.appendFileSync(process.env.FIXTURE_SELFTEST_EVENTS, JSON.stringify({
      key: process.env.ARENA_AGENT_BRIDGE_KEY || "",
      dataDir: process.env.DATA_DIR || "",
    }) + "\\n");
    process.exit(Number(process.env.FIXTURE_SELFTEST_EXIT || 0));
  `
  );

  fs.writeFileSync(
    path.join(root, "src/index.mjs"),
    `import fs from "node:fs";
    import http from "node:http";
    const boot = {
      pid: process.pid,
      port: Number(process.env.PORT),
      dataDir: process.env.DATA_DIR || "",
      key: process.env.ARENA_AGENT_BRIDGE_KEY || "",
      instance: process.env.ARENA_LAUNCHER_INSTANCE || "",
    };
    fs.appendFileSync(process.env.FIXTURE_BOOT_EVENTS, JSON.stringify(boot) + "\\n");
    const server = http.createServer((request, response) => {
      if (request.url !== "/health") { response.statusCode = 404; return response.end("{}"); }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        ok: true, ready: true, service: "arena-bridge", version: "fixture",
        launcherInstance: process.env.ARENA_LAUNCHER_INSTANCE || "",
        accounts: [{ email: "fixture@example.com" }],
        pid: process.pid,
      }));
    });
    server.listen(boot.port, "127.0.0.1");
    const stop = () => {
      fs.appendFileSync(process.env.FIXTURE_STOP_EVENTS, JSON.stringify({ pid: process.pid }) + "\\n");
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  `
  );
  // The two template helpers above are kept as strings so the fixture files stay
  // readable; the marker files exist before any child can append to them.
  for (const file of [events, boots, stops]) fs.writeFileSync(file, "");

  const lines = (file) =>
    fs.existsSync(file)
      ? fs
          .readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DATA_DIR: "",
    ARENA_EMAIL: "",
    ARENA_PASSWORD: "",
    ARENA_AGENT_CHROME: "",
    ARENA_AGENT_PROXY: "",
    FIXTURE_LOGIN_EVENTS: events,
    FIXTURE_SELFTEST_EVENTS: events,
    FIXTURE_BOOT_EVENTS: boots,
    FIXTURE_STOP_EVENTS: stops,
    FIXTURE_LOGIN_EXIT: "",
    FIXTURE_SELFTEST_EXIT: "",
    ARENA_INSTALL_HEALTH_TIMEOUT_MS: "15000",
    ARENA_INSTALL_STOP_TIMEOUT_MS: "5000",
  };

  const run = (args, extra = {}) => {
    const result = spawnSync(process.execPath, [path.join(root, "bin/install.mjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...env, ...extra },
    });
    assert.ifError(result.error);
    return result;
  };

  t.after(async () => {
    // Never leave a detached fixture bridge behind if an assertion threw before
    // the test's own --stop.
    for (const boot of lines(boots)) {
      if (!boot.pid) continue;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(boot.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        try {
          process.kill(boot.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { root, home, browser, events, boots, stops, lines, run };
}

function readEnv(file) {
  return parseEnvFile(fs.readFileSync(path.join(file, ".env"), "utf8"));
}

// ── options and .env, without a process ─────────────────────────────────────

test("parseArgs accepts install.sh's spellings and rejects a bad port", () => {
  const options = parseArgs(["--email", "a@b.c", "-p", "pw", "--port=21000", "--no-login", "--stop"]);
  assert.equal(options.email, "a@b.c");
  assert.equal(options.password, "pw");
  assert.equal(options.port, 21000);
  assert.equal(options.noLogin, true);
  assert.equal(options.stop, true);

  assert.throws(() => parseArgs(["--port", "0"]), (error) => error instanceof InstallError && error.exitCode === 2);
  assert.throws(() => parseArgs(["--nonsense"]), (error) => error instanceof InstallError && error.exitCode === 2);
  assert.throws(() => parseArgs(["--email"]), (error) => error instanceof InstallError && error.exitCode === 2);
  assert.throws(() => parseArgs(["--warp"]), /POSIX-only/);
});

test("the password prompt refuses a pipe instead of reading the wrong stream", async () => {
  // A non-interactive stdin (a pipe, a scheduled task) must fail with a way out,
  // not hang waiting for input nobody can type.
  await assert.rejects(promptPassword("person@example.com", { stdin: { isTTY: false } }), /not interactive/);
});

test("the password prompt masks what is typed", async () => {
  const listeners = new Map();
  const stdin = {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    on: (name, handler) => listeners.set(name, handler),
    removeListener: (name) => listeners.delete(name),
  };
  let written = "";
  const stderr = { write: (text) => { written += text; return true; } };
  const promise = promptPassword("person@example.com", { stdin, stderr });
  await new Promise((resolve) => setImmediate(resolve));
  const type = (text) => listeners.get("data")(text);
  type("corr");
  type("\u007f"); // backspace removes the last character
  type("rect\r");
  assert.equal(await promise, "correct");
  // The typed characters never reach the terminal: only the label, stars, and
  // the erase sequence a backspace produces. Nothing after the label may be a
  // letter or digit that could be read off a screenshot.
  assert.equal(written.includes("corr"), false, "the password must not be echoed");
  assert.ok(written.startsWith("Password for person@example.com: "), written);
  assert.match(written.slice("Password for person@example.com: ".length), /^\*+\u0008 \u0008\*+\n$/);
});

test("mergeEnvFile replaces only the keys this run manages and keeps comments", () => {
  const existing = [
    "# hand-written",
    "ARENA_RATE_LIMIT_RPM=5",
    "PORT=20140",
    'ARENA_AGENT_PROXY="socks5://127.0.0.1:40000"',
    "ARENA_AGENT_BRIDGE_KEY=old-key",
    "STORAGE_ENCRYPTION_KEY=keep-me",
    "",
  ].join("\n");
  const merged = mergeEnvFile(existing, [
    { key: "PORT", value: "21000" },
    { key: "ARENA_AGENT_PROXY", value: "" },
    { key: "ARENA_AGENT_BRIDGE_KEY", value: "new-key" },
    { key: "STORAGE_ENCRYPTION_KEY", value: "keep-me" },
  ]);
  assert.equal(
    merged,
    [
      "# hand-written",
      "ARENA_RATE_LIMIT_RPM=5",
      "PORT=21000",
      "ARENA_AGENT_BRIDGE_KEY=new-key",
      "STORAGE_ENCRYPTION_KEY=keep-me",
      "",
    ].join("\n")
  );
  assert.throws(() => mergeEnvFile("", [{ key: "PORT", value: "1\nEVIL=1" }]), /line break/);
});

// ── the whole install ───────────────────────────────────────────────────────

test("installs owner-only state, signs in without argv secrets, starts and stops the bridge", async (t) => {
  const fx = fixture(t);
  const port = await freePort();
  const dataDir = path.join(fx.root, "state dir 空格");
  const result = fx.run([
    "--email",
    "fixture@example.com",
    "--password",
    "argument-fixture",
    "--data-dir",
    dataDir,
    "--chrome",
    fx.browser,
    "--port",
    String(port),
  ]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /is UP/);
  assert.doesNotMatch(result.stdout, /\uFFFD/, "console output must stay ASCII for cmd.exe");

  const env = readEnv(dataDir);
  assert.equal(env.PORT, String(port));
  assert.equal(env.ARENA_AGENT_CHROME, fx.browser);
  assert.equal(env.ARENA_AGENT_PROXY, undefined);
  assert.equal(env.DATA_DIR, dataDir);
  assert.match(env.ARENA_AGENT_BRIDGE_KEY, /^[a-f0-9]{48}$/);
  assert.match(env.STORAGE_ENCRYPTION_KEY, /^[a-f0-9]{64}$/);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dataDir, ".env")).mode & 0o777, 0o600);

  const login = fx.lines(fx.events).find((event) => event.argv);
  assert.ok(login, "the login fixture did not run");
  assert.deepEqual(login.argv, ["--email", "fixture@example.com"]);
  assert.equal(login.password, "argument-fixture", "the password must travel in the environment");
  assert.equal(login.key, env.ARENA_AGENT_BRIDGE_KEY);
  assert.equal(login.chrome, fx.browser);
  assert.doesNotMatch(login.argv.join(" "), /argument-fixture/, "never put the password on the command line");

  const boot = fx.lines(fx.boots).at(-1);
  assert.equal(boot.port, port);
  assert.equal(boot.dataDir, dataDir);
  assert.equal(boot.key, env.ARENA_AGENT_BRIDGE_KEY);

  const pid = JSON.parse(fs.readFileSync(path.join(dataDir, "bridge.pid.json"), "utf8"));
  assert.equal(pid.pid, boot.pid);
  assert.equal(pid.instance, boot.instance);
  assert.equal(pid.port, port);

  const running = await until(() => health(port));
  assert.ok(running, "the fixture bridge should answer /health");
  assert.equal(running.launcherInstance, boot.instance);

  const status = fx.run(["--status", "--data-dir", dataDir]);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /running on/);

  const stopped = fx.run(["--stop", "--data-dir", dataDir]);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /Stopped/);
  assert.equal(fs.existsSync(path.join(dataDir, "bridge.pid.json")), false);
  assert.ok(await until(async () => !(await health(port))), "the fixture bridge should stop answering");
  if (process.platform !== "win32") assert.equal(fx.lines(fx.stops).length, 1, "the bridge should get SIGTERM, not SIGKILL");

  const again = fx.run(["--stop", "--data-dir", dataDir]);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /No bridge started by this installer is running/);
});

test("re-running keeps both keys and unrelated .env content", (t) => {
  const fx = fixture(t);
  const dataDir = path.join(fx.root, "state");
  const first = fx.run(["--no-login", "--data-dir", dataDir, "--chrome", fx.browser]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /installed \(no sign-in yet\)/);
  const env = fs.readFileSync(path.join(dataDir, ".env"), "utf8");
  const keys = parseEnvFile(env);
  assert.match(keys.ARENA_AGENT_BRIDGE_KEY, /^[a-f0-9]{48}$/);

  fs.appendFileSync(path.join(dataDir, ".env"), "# keep this comment\nARENA_RATE_LIMIT_RPM=7\n");
  const second = fx.run(["--no-login", "--data-dir", dataDir, "--chrome", fx.browser]);
  assert.equal(second.status, 0, second.stderr);
  const after = fs.readFileSync(path.join(dataDir, ".env"), "utf8");
  assert.equal(parseEnvFile(after).ARENA_AGENT_BRIDGE_KEY, keys.ARENA_AGENT_BRIDGE_KEY);
  assert.equal(parseEnvFile(after).STORAGE_ENCRYPTION_KEY, keys.STORAGE_ENCRYPTION_KEY);
  assert.match(after, /# keep this comment/);
  assert.match(after, /ARENA_RATE_LIMIT_RPM=7/);

  const rotated = fx.run(["--no-login", "--data-dir", dataDir, "--chrome", fx.browser, "--key", "explicit-key"]);
  assert.equal(rotated.status, 0, rotated.stderr);
  assert.equal(readEnv(dataDir).ARENA_AGENT_BRIDGE_KEY, "explicit-key");
  assert.equal(readEnv(dataDir).STORAGE_ENCRYPTION_KEY, keys.STORAGE_ENCRYPTION_KEY);
});

test("the browser is visible by default, and --headless (or ARENA_HEADED=0) opts out", async (t) => {
  const fx = fixture(t);
  const port = await freePort();
  const dataDir = path.join(fx.root, "state");
  const base = ["--email", "fixture@example.com", "--password", "pw", "--data-dir", dataDir, "--no-start"];

  const plain = fx.run([...base, "--chrome", fx.browser]);
  assert.equal(plain.status, 0, plain.stderr + plain.stdout);
  assert.equal(fx.lines(fx.events).find((event) => event.argv).headed, "1", "headed is the default");
  assert.equal(readEnv(dataDir).ARENA_HEADED, "1", "and it is remembered for later starts");

  // A windowless run has to be asked for, and is remembered too.
  const headless = fx.run([...base, "--chrome", fx.browser, "--headless"]);
  assert.equal(headless.status, 0, headless.stderr + headless.stdout);
  assert.equal(fx.lines(fx.events).filter((event) => event.argv).at(-1).headed, "");
  assert.equal(readEnv(dataDir).ARENA_HEADED, "0");
  assert.equal(fx.lines(fx.boots).length, 0, "--no-start must not start a bridge");

  // …and a plain re-run respects that stored 0 instead of flipping it back.
  const again = fx.run([...base, "--chrome", fx.browser]);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.equal(fx.lines(fx.events).filter((event) => event.argv).at(-1).headed, "");

  // --headed is still accepted for old command lines.
  const forced = fx.run([...base, "--chrome", fx.browser, "--headed"]);
  assert.equal(forced.status, 0, forced.stderr + forced.stdout);
  assert.equal(fx.lines(fx.events).filter((event) => event.argv).at(-1).headed, "1");
  assert.equal(readEnv(dataDir).ARENA_HEADED, "1");
});

test("--start brings the installed bridge back without signing in again", async (t) => {
  const fx = fixture(t);
  const port = await freePort();
  const dataDir = path.join(fx.root, "state");
  const installed = fx.run(["--no-login", "--data-dir", dataDir, "--chrome", fx.browser, "--port", String(port)]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.deepEqual(fx.lines(fx.events), [], "--no-login must not run the login step");

  const started = fx.run(["--start", "--data-dir", dataDir]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  assert.match(started.stdout, /using the saved account/);
  assert.deepEqual(fx.lines(fx.events), [], "--start must reuse the stored account");
  assert.equal(fx.lines(fx.boots).at(-1).port, port);
  assert.ok(await until(() => health(port)), "the bridge should be running after --start");
  assert.equal(fx.run(["--stop", "--data-dir", dataDir]).status, 0);
});

test("--start refuses a data directory the installer never provisioned", (t) => {
  const fx = fixture(t);
  const result = fx.run(["--start", "--data-dir", path.join(fx.root, "empty")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no ARENA_AGENT_BRIDGE_KEY/);
});

test("refuses to continue without an email, and a failed login starts nothing", (t) => {
  const fx = fixture(t);
  const dataDir = path.join(fx.root, "state");
  const missing = fx.run(["--data-dir", dataDir, "--chrome", fx.browser]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no email/);
  assert.deepEqual(fx.lines(fx.events), []);
  assert.deepEqual(fx.lines(fx.boots), []);

  const failed = fx.run(
    ["--email", "fixture@example.com", "--password", "pw", "--data-dir", dataDir, "--chrome", fx.browser],
    { FIXTURE_LOGIN_EXIT: "1" }
  );
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /login failed/i);
  assert.deepEqual(fx.lines(fx.boots), []);
  assert.equal(fs.existsSync(path.join(dataDir, "bridge.pid.json")), false);
});

test("never stops a bridge it did not start", async (t) => {
  // A real child, not an in-process server: spawnSync blocks this event loop,
  // which would make an in-process foreign bridge unreachable to the installer.
  const port = await freePort();
  const foreign = spawn(
    process.execPath,
    [
      "-e",
      `const http = require("http");
       const server = http.createServer((request, response) => {
         response.setHeader("Content-Type", "application/json");
         response.end(JSON.stringify({ ok: true, service: "arena-bridge", launcherInstance: "someone-else" }));
       });
       server.listen(Number(process.argv[1]), "127.0.0.1", () => console.log("ready"));`,
      String(port),
    ],
    { stdio: ["ignore", "pipe", "inherit"], windowsHide: true }
  );
  await new Promise((resolve, reject) => {
    foreign.once("error", reject);
    foreign.stdout.on("data", (chunk) => String(chunk).includes("ready") && resolve());
  });
  t.after(() => {
    try {
      foreign.kill();
    } catch {
      /* already gone */
    }
  });

  const fx = fixture(t);
  const dataDir = path.join(fx.root, "state");
  const stopped = fx.run(["--stop", "--port", String(port), "--data-dir", dataDir]);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /Not stopping it/);
  assert.ok(await health(port), "the foreign bridge must still be answering");

  // A record whose instance no longer matches is not ours either.
  const startedAt = Date.now();
  const boot = fx.run(
    ["--email", "fixture@example.com", "--password", "pw", "--data-dir", dataDir, "--chrome", fx.browser, "--port", String(port)],
    { ARENA_INSTALL_HEALTH_TIMEOUT_MS: "2000" }
  );
  assert.equal(boot.status, 1, "starting on a foreign port must fail");
  assert.match(boot.stderr, /did not start it|already serving/);
  assert.ok(Date.now() - startedAt < 20_000);
});

test("--stop refuses a pid record whose instance no longer matches /health", async (t) => {
  const fx = fixture(t);
  const port = await freePort();
  const dataDir = path.join(fx.root, "state");
  const started = fx.run([
    "--email",
    "fixture@example.com",
    "--password",
    "pw",
    "--data-dir",
    dataDir,
    "--chrome",
    fx.browser,
    "--port",
    String(port),
    "--no-selftest",
  ]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const file = path.join(dataDir, "bridge.pid.json");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...record, instance: "not-this-installer" }));

  const refused = fx.run(["--stop", "--data-dir", dataDir]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /instance mismatch/);
  assert.ok(await health(port), "a mismatched record must not get the process killed");

  fs.writeFileSync(file, JSON.stringify(record));
  assert.equal(fx.run(["--stop", "--data-dir", dataDir]).status, 0);
});

test("a failed health check tears the half-started bridge down and says why", async (t) => {
  const fx = fixture(t);
  const dataDir = path.join(fx.root, "state");
  fs.mkdirSync(dataDir, { recursive: true });
  // The fixture bridge listens on this port; make it answer something that is
  // not a healthy arena-bridge by pointing the installer at an unused port and
  // removing index.mjs so the child exits immediately.
  fs.rmSync(path.join(fx.root, "src/index.mjs"));
  const port = await freePort();
  const result = fx.run(
    ["--email", "fixture@example.com", "--password", "pw", "--data-dir", dataDir, "--chrome", fx.browser, "--port", String(port)],
    { ARENA_INSTALL_HEALTH_TIMEOUT_MS: "3000" }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exited during startup|did not become healthy/);
  assert.equal(fs.existsSync(path.join(dataDir, "bridge.pid.json")), false, "a failed start must not leave a pid record");
});

test("a partial self-test is reported without failing the install", async (t) => {
  const fx = fixture(t);
  const port = await freePort();
  const dataDir = path.join(fx.root, "state");
  const started = fx.run(
    ["--email", "fixture@example.com", "--password", "pw", "--data-dir", dataDir, "--chrome", fx.browser, "--port", String(port)],
    { FIXTURE_SELFTEST_EXIT: "2" }
  );
  assert.equal(started.status, 0, started.stderr + started.stdout);
  assert.match(started.stdout, /Self-test  : PARTIAL/);
  const stop = fx.run(["--stop", "--data-dir", dataDir]);
  assert.equal(stop.status, 0, stop.stderr);
});

test("install.bat hands every argument to Node untouched and never needs bash", () => {
  const bat = fs.readFileSync(new URL("../install.bat", import.meta.url), "utf8");
  const bootstrap = fs.readFileSync(new URL("../bin/bootstrap-node.ps1", import.meta.url), "utf8");
  // The arguments go from cmd to Node directly. Routing them through PowerShell
  // would be lossy: PowerShell eats "--" as its end-of-parameters marker.
  assert.match(bat, /"%NODE%" "%ROOT%bin\\install\.mjs" %\*/);
  assert.equal(bat.includes('bootstrap-node.ps1" %*'), false, "never pass the user's flags through PowerShell");
  assert.match(bat, /exit \/b %CODE%/);
  const commands = bat
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.toLowerCase().startsWith("rem"));
  assert.equal(commands.some((line) => /\bbash\b/i.test(line)), false, "the Windows entry point must not call bash");
  assert.match(bootstrap, /-id OpenJS\.NodeJS\.LTS/, "a machine without Node must be offered an install");
  assert.match(bootstrap, /nodejs\.org\/en\/download/, "and told where to get it by hand");
  // install.bat asks for Windows PowerShell 5.1, so PS7-only syntax would fail.
  assert.doesNotMatch(bootstrap, /\?\?/, "the null-coalescing operator does not exist in PowerShell 5.1");
});

test("--help documents the flags the Windows launcher passes through", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/install.mjs", import.meta.url)), "--help"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  for (const option of ["--email", "--password", "--key", "--port", "--proxy", "--data-dir", "--chrome", "--no-login", "--no-start", "--start", "--stop", "--status"]) {
    assert.match(result.stdout, new RegExp(option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(result.stdout, /install\.bat/);
});
