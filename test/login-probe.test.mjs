// The post-login probe is the difference between "stored a working account" and
// "stored an account the bridge can never use". Its predecessor answered with a
// bare "does the HTML contain the email?", so any page that did not mention the
// account — a restricted one, but equally one whose markup changed — counted as
// restricted and the sign-in was thrown away. These tests pin down the tri-state
// that replaced it: only positive evidence refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySessionProbe } from "../src/arena-login.mjs";

const EMAIL = "person@example.com";

test("an account's own email in the /agent payload is the usable signal", () => {
  assert.equal(
    classifySessionProbe({ status: 200, html: `<script>{"user":{"email":"${EMAIL}"}}</script>`, email: EMAIL }),
    "usable"
  );
  assert.equal(
    classifySessionProbe({ status: 200, html: "PERSON@EXAMPLE.COM", email: EMAIL }),
    "usable",
    "the match is case-insensitive, like the address itself"
  );
});

test("a refusal from Arena is the only unusable verdict", () => {
  for (const status of [401, 403, 404, 500, 503]) {
    assert.equal(classifySessionProbe({ status, html: "", email: EMAIL }), "unusable", `status ${status}`);
  }
});

test("a 200 that does not mention the account is unknown, not a refusal", () => {
  // This is the case that used to lock every account out after a page change.
  assert.equal(classifySessionProbe({ status: 200, html: "<html><body>Sign in</body></html>", email: EMAIL }), "unknown");
  assert.equal(classifySessionProbe({ status: 200, html: "", email: EMAIL }), "unknown");
  assert.equal(classifySessionProbe({ status: 200, html: "unrelated", email: "" }), "unknown", "no identity to look for");
  assert.equal(classifySessionProbe({}), "unknown", "an empty probe proves nothing");
});
