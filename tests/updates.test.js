// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const U = require("../updates.js");

test("each update state has honest text and the right action", () => {
  const v = (state, extra) => U.updateView({ state, current: "1.1.7", ...extra });
  assert.deepEqual(v("checking"), { line: "Version 1.1.7 · Checking for updates…", action: null, banner: false });
  assert.equal(v("current").action, "check");
  assert.match(v("current").line, /Up to date/);
  assert.equal(v("downloading", { version: "1.1.9", percent: 41.6 }).line, "Version 1.1.7 · Downloading 1.1.9… 42%");
  const ready = v("ready", { version: "1.1.9" });
  assert.equal(ready.action, "install");
  assert.equal(ready.banner, true);
  assert.match(ready.line, /1\.1\.9 is ready/);
  assert.equal(v("error", { message: "getaddrinfo ENOTFOUND github.com" }).line, "Version 1.1.7 · Couldn't check for updates (no internet connection).");
  assert.equal(v("portable").action, "download");
  assert.equal(v("dev").action, null);
  assert.equal(U.updateView(null).line, "");
});

test("shortError keeps long errors short", () => {
  assert.equal(U.shortError("net::ERR_INTERNET_DISCONNECTED"), "no internet connection");
  const long = "x".repeat(200) + "\nstack";
  assert.equal(U.shortError(long).length, 78);
  assert.equal(U.shortError("HttpError: 404\nmore"), "HttpError: 404");
});
