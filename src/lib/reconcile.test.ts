/**
 * Unit tests for pending → posted reconciliation.
 *
 * Scenario throughout: the real pending rows in the ledger as of 2026-07-24, and the
 * statement that will settle them. Without this logic each one becomes a duplicate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSettlements, type ExistingPending } from "./reconcile";
import type { ParsedRow } from "./adapters";

const pending = (o: Partial<ExistingPending> = {}): ExistingPending => ({
  id: "p1", txn_date: "2026-07-24", raw_description: "OLIVE GARDEN 0021813",
  normalized_merchant: "OLIVE GARDEN", amount: "-34.00", status: "pending", ...o,
});

const posted = (o: Partial<ParsedRow> = {}): ParsedRow => ({
  txnDate: "2026-07-26", postDate: null, rawDescription: "OLIVE GARDEN 0021813",
  normalizedMerchant: "OLIVE GARDEN", amount: -40.8, status: "posted",
  bankCategory: null, purchasedBy: null, txnType: null, occurrenceN: 1, ...o,
});

test("settles a restaurant authorization once the tip lands", () => {
  const { settlements, fresh } = matchSettlements([posted()], [pending()]);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].pendingId, "p1");
  assert.equal(fresh.length, 0, "must not also insert the row");
});

test("settles an unchanged amount", () => {
  const r = matchSettlements([posted({ amount: -34.0, txnDate: "2026-07-25" })], [pending()]);
  assert.equal(r.settlements.length, 1);
});

test("rejects an amount that moved too far", () => {
  // 25% tolerance + $1: a $240 charge is not a settlement of a $34 authorization.
  const r = matchSettlements([posted({ amount: -240 })], [pending()]);
  assert.equal(r.settlements.length, 0);
  assert.equal(r.fresh.length, 1);
});

test("rejects a settlement that arrives too late", () => {
  const r = matchSettlements([posted({ txnDate: "2026-08-04" })], [pending()]);
  assert.equal(r.settlements.length, 0);
});

test("never settles backwards in time", () => {
  // Posting cannot precede the authorization.
  const r = matchSettlements([posted({ txnDate: "2026-07-20" })], [pending()]);
  assert.equal(r.settlements.length, 0);
});

test("requires the merchant's first token to agree", () => {
  const r = matchSettlements([posted({ normalizedMerchant: "PAYPAL" })], [pending()]);
  assert.equal(r.settlements.length, 0, "same amount and date is not enough");
});

test("one pending row absorbs at most one posted row", () => {
  // Otherwise a single authorization swallows several genuine repeat charges.
  const r = matchSettlements([posted(), posted()], [pending()]);
  assert.equal(r.settlements.length, 1);
  assert.equal(r.fresh.length, 1);
});

test("a still-pending re-export is left to fingerprint dedup", () => {
  const r = matchSettlements([posted({ status: "pending", amount: -34 })], [pending()]);
  assert.equal(r.settlements.length, 0);
  assert.equal(r.fresh.length, 1);
});

test("picks the closest match when several pending rows compete", () => {
  const r = matchSettlements([posted({ amount: -34.5 })], [
    pending({ id: "far", amount: "-30.00" }),
    pending({ id: "near", amount: "-34.00" }),
  ]);
  assert.equal(r.settlements[0].pendingId, "near");
});

test("passes everything through when nothing is pending", () => {
  const r = matchSettlements([posted(), posted()], []);
  assert.equal(r.settlements.length, 0);
  assert.equal(r.fresh.length, 2);
});
