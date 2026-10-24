// Reading a Session's /out stream is where a restricted account finally shows
// itself: create-chat succeeds, the page carries a token, and the read is
// refused with 403. That error used to say only "Arena Agent output failed: 403",
// which is indistinguishable from a stale token -- so these tests pin down the
// two behaviours that make it diagnosable: the refusal's own body is carried on
// the error, and a token that was merely stale is refreshed and retried once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readAgentTurn, readOutputOnce, sessionTokenFromRequest } from "../src/bridge.mjs";

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
        nextToken: async () => {
          seen.push("refresh");
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


// ── the token the page itself used ──────────────────────────────────────────

test("sessionTokenFromRequest reads the page's own bearer token", () => {
  const found = sessionTokenFromRequest(
    "https://arena.ai/ai-proxy/realtime/v1/sessions/01a16dcb-120a-7b3d-8d69-ddc6949c96ab/out",
    { authorization: "Bearer abc.def.ghi" }
  );
  assert.deepEqual(found, { id: "01a16dcb-120a-7b3d-8d69-ddc6949c96ab", token: "abc.def.ghi" });
});

test("sessionTokenFromRequest ignores anything that is not an /out read with a bearer", () => {
  const out = "https://arena.ai/ai-proxy/realtime/v1/sessions/01a16dcb-120a-7b3d-8d69-ddc6949c96ab/out";
  assert.equal(sessionTokenFromRequest(out, {}), null, "no Authorization header");
  assert.equal(sessionTokenFromRequest(out, { authorization: "Basic xyz" }), null, "not a bearer");
  assert.equal(
    sessionTokenFromRequest("https://arena.ai/ai-proxy/realtime/v1/sessions/01a16dcb-120a-7b3d-8d69-ddc6949c96ab/in/append", {
      authorization: "Bearer abc",
    }),
    null,
    "only the read stream"
  );
  assert.equal(sessionTokenFromRequest("", { authorization: "Bearer abc" }), null);
});

test("a live token is tried before a re-scrape, and each only once", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const tried = [];
  const state = { id: "11111111-2222-4333-8444-555555555555", token: "scraped-stale", lastEventId: "" };
  const candidates = ["live-token", "scraped-stale", "scraped-fresh"];
  globalThis.fetch = async (url, options) => {
    tried.push(options.headers.Authorization);
    return options.headers.Authorization === "Bearer scraped-fresh"
      ? new Response(TURN, { status: 200 })
      : new Response("forbidden", { status: 403 });
  };
  const raw = await readAgentTurn({
    state,
    readOnce: () => readOutputOnce(page(), state),
    nextToken: async () => candidates.shift() || "",
  });
  assert.equal(raw, TURN);
  assert.deepEqual(tried, ["Bearer scraped-stale", "Bearer live-token", "Bearer scraped-fresh"]);
  assert.equal(state.token, "scraped-fresh");
});

test("the candidate list stops the loop when nothing new is left", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let reads = 0;
  const state = { id: "11111111-2222-4333-8444-555555555555", token: "only-token", lastEventId: "" };
  globalThis.fetch = async () => {
    reads += 1;
    return new Response("nope", { status: 403 });
  };
  await assert.rejects(
    readAgentTurn({ state, readOnce: () => readOutputOnce(page(), state), nextToken: async () => "" }),
    /403/
  );
  assert.equal(reads, 1, "no candidates means no pointless retry");
});
