// ARENA_HEADED and ARENA_DEPLOYMENT_PIN are read by modules that never see the
// config object, so DATA_DIR/.env used to be invisible to them: an install could
// write ARENA_HEADED=1 and still get a headless browser. These tests pin down the
// hand-over, including the rule that the real environment always wins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRuntimeEnv } from "../src/config.mjs";

test("a value in DATA_DIR/.env reaches process.env when the environment is silent", () => {
  const env = {};
  const applied = applyRuntimeEnv({ ARENA_HEADED: "1", ARENA_DEPLOYMENT_PIN: "none" }, env);
  assert.equal(env.ARENA_HEADED, "1");
  assert.equal(env.ARENA_DEPLOYMENT_PIN, "none");
  assert.deepEqual(applied.sort(), ["ARENA_DEPLOYMENT_PIN", "ARENA_HEADED"].sort());
});

test("the real environment wins over the file", () => {
  const env = { ARENA_HEADED: "0" };
  applyRuntimeEnv({ ARENA_HEADED: "1" }, env);
  assert.equal(env.ARENA_HEADED, "0", "ARENA_HEADED=0 node src/index.mjs stays an override");
});

test("blank entries and unrelated keys are left alone", () => {
  const env = {};
  const applied = applyRuntimeEnv({ ARENA_HEADED: "   ", PORT: "21000", OTHER: "x" }, env);
  assert.deepEqual(applied, []);
  assert.equal(env.ARENA_HEADED, undefined);
  assert.equal(env.OTHER, undefined, "only the documented pass-through names are applied");
});

test("values are trimmed, and a missing .env is harmless", () => {
  const env = {};
  applyRuntimeEnv({ ARENA_HEADED: " 1 " }, env);
  assert.equal(env.ARENA_HEADED, "1");
  assert.deepEqual(applyRuntimeEnv(undefined, {}), []);
});
