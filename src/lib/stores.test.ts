/**
 * Unit tests for canonical vendor resolution.
 *
 * The two properties that matter: LONGEST match wins (so a brand whose name contains a
 * number survives), and matching stops at a TOKEN BOUNDARY (so one vendor cannot claim
 * another's rows).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStoreIndex, resolveStore, type StoreAlias } from "./stores";

const A = (pattern: string, storeId: string): StoreAlias => ({ pattern, storeId });

const idx = buildStoreIndex([
  A("THE HOME DEPOT", "home-depot"),
  A("THE HOME DEPOT BOSSIER CITY", "home-depot"),
  A("MOTEL", "motel-generic"),
  A("MOTEL 8", "motel-8"),
  A("SHELL", "shell"),
  A("SHELLY EUROPE", "shelly"),
  A("ALDI", "aldi"),
  A("SAM S CLUB", "sams-club"),
]);

test("resolves an exact alias", () => {
  assert.equal(resolveStore("ALDI", idx), "aldi");
});

test("resolves a descriptor carrying a location suffix", () => {
  assert.equal(resolveStore("ALDI BOSSIER CITY", idx), "aldi");
  assert.equal(resolveStore("THE HOME DEPOT BOSSIER CITY", idx), "home-depot");
});

test("LONGEST match wins — this is what saves Motel 8", () => {
  // The whole reason for the canonical table: no stripping rule has to know the 8 is
  // part of the brand, because "Motel 8" is itself a vendor and outranks "Motel".
  assert.equal(resolveStore("MOTEL 8 BOSSIER CITY", idx), "motel-8");
  assert.equal(resolveStore("MOTEL 6 SHREVEPORT", idx), "motel-generic");
});

test("matching stops at a token boundary", () => {
  // A bare LIKE 'SHELL%' would give Shelly Europe's rows to the fuel brand. Both are
  // real vendors in this ledger.
  assert.equal(resolveStore("SHELLY EUROPE EO IAT", idx), "shelly");
  assert.equal(resolveStore("SHELL OIL BIG RAPIDS", idx), "shell");
  assert.equal(resolveStore("SHELLFISH COMPANY", idx), null, "must not match SHELL");
});

test("returns null for a genuinely new vendor", () => {
  assert.equal(resolveStore("SOME BRAND NEW PLACE", idx), null);
  assert.equal(resolveStore("", idx), null);
});

test("is case- and whitespace-insensitive on input", () => {
  assert.equal(resolveStore("  aldi bossier city  ", idx), "aldi");
});

test("index buckets by first token and keeps longest patterns first", () => {
  const bucket = buildStoreIndex([A("A B C", "x"), A("A", "y"), A("A B", "z")]).get("A")!;
  assert.deepEqual(bucket.map((b) => b.pattern), ["A B C", "A B", "A"]);
});
