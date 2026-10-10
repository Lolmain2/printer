// Run with: npm test
// The desktop exe only contains files listed in package.json "build.files";
// a script the page loads but the list forgets would break the exe silently.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("every file index.html loads is packaged into the exe", () => {
  const files = new Set(pkg.build.files);
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const styles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 5, "expected the app's scripts in index.html");
  for (const f of [...scripts, ...styles]) {
    assert.ok(files.has(f), `${f} is loaded by index.html but missing from package.json build.files`);
    assert.ok(fs.existsSync(path.join(root, f)), `${f} does not exist`);
  }
});

test("packaged files exist", () => {
  for (const f of pkg.build.files) assert.ok(fs.existsSync(path.join(root, f)), `${f} listed in build.files but missing`);
});
