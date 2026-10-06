const { test } = require("node:test");
const assert = require("node:assert/strict");

const { canonical, checksum, decide } = require("../src/services/bundleSync");

/*
 * The upgrade rule every bundle install endpoint shares: a firm's edits to a
 * bundle-shipped item are never overwritten. (Identical copies of this test
 * live beside each copy of bundleSync.js.)
 */

const shipped = { name: "Statutory Audit", description: "Audit under the Companies Act" };

test("canonical form ignores key order", () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), canonical({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.equal(checksum({ b: 1, a: 2 }), checksum({ a: 2, b: 1 }));
  assert.notEqual(checksum({ a: 1 }), checksum({ a: "1" }));
});

test("a new item is inserted", () => {
  assert.equal(decide(null, shipped).action, "insert");
});

test("an item already holding the shipped content is unchanged", () => {
  assert.equal(decide({ content: { ...shipped }, sourceChecksum: checksum(shipped) }, shipped).action, "unchanged");
});

test("an untouched item takes the new version", () => {
  const v1 = { ...shipped, description: "old wording" };

  assert.equal(decide({ content: v1, sourceChecksum: checksum(v1) }, shipped).action, "update");
});

test("an item the firm edited is kept, and flagged when the bundle moved on", () => {
  const v1 = { ...shipped, description: "old wording" };
  const edited = { ...v1, name: "Statutory audit (our way)" };
  const result = decide({ content: edited, sourceChecksum: checksum(v1) }, shipped);

  assert.equal(result.action, "keep");
  assert.equal(result.flag, true);
});

test("an edited item is kept without a flag when the bundle ships the same thing again", () => {
  const edited = { ...shipped, name: "Our audit" };
  const result = decide({ content: edited, sourceChecksum: checksum(shipped) }, shipped);

  assert.equal(result.action, "keep");
  assert.equal(result.flag, false);
});

test("a pre-existing row the bundle adopts is treated as the firm's", () => {
  const result = decide({ content: { ...shipped, description: "their own" }, sourceChecksum: null }, shipped);

  assert.equal(result.action, "keep");
  assert.equal(result.flag, true);
});
