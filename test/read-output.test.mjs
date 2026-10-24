// Reading a Session's /out stream is where a restricted account finally shows
// itself: create-chat succeeds, the page carries a token, and the read is
// refused with 403. That error used to say only "Arena Agent output failed: 403",
// which is indistinguishable from a stale token -- so these tests pin down the
// two behaviours that make it diagnosable: the refusal's own body is carried on
// the error, and a token that was merely stale is refreshed and retried once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readAgentTurn, readOutputOnce } from "../src/bridge.mjs";

const STATE = () => ({ id: "11111111-2222-4333-8444-555555555555", token: "stale-token", lastEventId: "" });

/** The real policy, with only the two effects it has stubbed. */
function bridgeWith({ fetchImpl, freshToken = "" }) {
  const seen = [];
  globalThis.fetch = fetchImpl;
  const bridge = {
    readAgentOutput: (pageRef, state) =>
      readAgentTurn({
        state,
        readOnce: () => readOutputOnce(pageRef, state),
        refreshToken: async () => {
          seen.push("refresh");
          if (freshToken) state.token = freshToken;
          return freshToken;
        },
      }),
  };
  return { bridge, seen };
}

function page() {
  // The real method hands the work to the page; here the "page" is this process,
  // which is exactly what makes the in-page fetch stubbable.
  return { evaluate: (fn, args) => fn(args) };
}

/** The SSE the bridge accepts as a finished turn. */
const TURN = 'data: {"type":"finish","nodeId":"n1"}\n\ndata: turn-complete\n\n';

test("a refused read carries Arena's own words on the error", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const { bridge } = bridgeWith({
    fetchImpl: async () => new Response('{"error":"recaptcha validation failed"}', { status: 403 }),
  });
  await assert.rejects(bridge.readAgentOutput(page(), STATE()), (error) => {
    assert.equal(error.status, 403);
    assert.match(error.message, /Arena Agent output failed: 403/);
    assert.match(error.message, /recaptcha validation failed/, "the body has to survive");
    return true;
  });
});

test("a stale token is re-scraped and the read retried once", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const tokens = [];
  const { bridge, seen } = bridgeWith({
    freshToken: "fresh-token",
    fetchImpl: async (url, options) => {
      tokens.push(options.headers.Authorization);
      // Only the re-scraped token is accepted, like a Deployment that rotated.
      return options.headers.Authorization === "Bearer fresh-token"
        ? new Response(TURN, { status: 200 })
        : new Response("forbidden", { status: 403 });
    },
  });
  const state = STATE();
  assert.equal(await bridge.readAgentOutput(page(), state), TURN);
  assert.deepEqual(tokens, ["Bearer stale-token", "Bearer fresh-token"]);
  assert.deepEqual(seen, ["refresh"], "exactly one refresh, not a loop");
  assert.equal(state.token, "fresh-token", "the Session keeps the working token");
});

test("a refusal that survives the refresh is not retried again", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let reads = 0;
  const { bridge } = bridgeWith({
    freshToken: "fresh-token",
    fetchImpl: async () => {
      reads += 1;
      return new Response("nope", { status: 403 });
    },
  });
  await assert.rejects(bridge.readAgentOutput(page(), STATE()), /403/);
  assert.equal(reads, 2, "one read plus one retry; a restricted account must fail fast");
});

test("the same token twice is not worth a second read", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let reads = 0;
  const { bridge } = bridgeWith({
    // The page still serves the token it already gave us — nothing to try.
    fetchImpl: async () => {
      reads += 1;
      return new Response("{}", { status: 401 });
    },
  });
  await assert.rejects(bridge.readAgentOutput(page(), STATE()), /401/);
  assert.equal(reads, 1);
});
