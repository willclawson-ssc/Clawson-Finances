/**
 * Unit tests for rule matching and precedence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleMatches, pickRule, type Rule } from "./rules";

const R = (o: Partial<Rule>): Rule => ({
  id: "r", pattern: "ALDI", match_type: "prefix", keyword: null,
  category_id: "groceries", priority: 100, ...o,
});

test("prefix rules match at a token boundary only", () => {
  const r = R({ pattern: "ALDI" });
  assert.ok(ruleMatches(r, "ALDI"));
  assert.ok(ruleMatches(r, "ALDI BOSSIER CITY"));
  assert.equal(ruleMatches(r, "ALDIS MARKET"), false, "must not match a longer word");
});

test("exact rules match only the whole string", () => {
  const r = R({ pattern: "ALDI", match_type: "exact" });
  assert.ok(ruleMatches(r, "ALDI"));
  assert.equal(ruleMatches(r, "ALDI BOSSIER CITY"), false);
});

test("a keyword qualifier splits a multi-category vendor", () => {
  // Every Sam's Club "Transportation" row in the sheet literally says "gas".
  const gas = R({ pattern: "SAM S CLUB", keyword: "gas", category_id: "transportation" });
  assert.ok(ruleMatches(gas, "SAM S CLUB", "gas - prius"));
  assert.equal(ruleMatches(gas, "SAM S CLUB", "assorted groceries"), false);
});

test("a qualified rule outranks the bare vendor rule", () => {
  const bare = R({ id: "bare", pattern: "SAM S CLUB", category_id: "groceries" });
  const gas = R({ id: "gas", pattern: "SAM S CLUB", keyword: "gas", category_id: "transportation" });
  assert.equal(pickRule([bare, gas], "SAM S CLUB", "gas for will")?.id, "gas");
  assert.equal(pickRule([bare, gas], "SAM S CLUB", "groceries")?.id, "bare");
});

test("the more specific pattern wins", () => {
  const short = R({ id: "short", pattern: "SAM" });
  const long = R({ id: "long", pattern: "SAM S CLUB" });
  assert.equal(pickRule([short, long], "SAM S CLUB BOSSIER CITY")?.id, "long");
});

test("exact beats prefix at equal specificity", () => {
  const p = R({ id: "p", pattern: "ALDI", match_type: "prefix" });
  const e = R({ id: "e", pattern: "ALDI", match_type: "exact" });
  assert.equal(pickRule([p, e], "ALDI")?.id, "e");
});

test("no match returns null rather than a guess", () => {
  assert.equal(pickRule([R({})], "SOMEWHERE ELSE"), null);
});
