/**
 * Unit tests for transfer pairing.
 *
 * Cases are the real movements in the ledger: the 2026-07-21 "Credit Card Payment"
 * -2142.57 that appears in both USAA files, and the Discover payment whose legs sit three
 * days apart (Discover 07/10 <-> USAA 07/13).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pairTransfers, type TransferLeg } from "./transfers";

const CHECKING = "acct-usaa-checking";
const CARD = "acct-usaa-card";
const DISCOVER = "acct-discover";

const leg = (o: Partial<TransferLeg> = {}): TransferLeg => ({
  id: "l1", accountId: CHECKING, txnDate: "2026-07-21", amount: -2142.57, ...o,
});

test("pairs a card payment's two legs", () => {
  const r = pairTransfers([
    leg({ id: "bank" }),
    leg({ id: "card", accountId: CARD, amount: 2142.57 }),
  ]);
  assert.equal(r.pairs.length, 1);
  assert.equal(r.ambiguous.length, 0);
  assert.deepEqual(
    { out: r.pairs[0].outflowId, in: r.pairs[0].inflowId, amt: r.pairs[0].amount },
    { out: "bank", in: "card", amt: 2142.57 },
  );
});

test("pairs across the measured 3-day lag and dates the movement to the earlier leg", () => {
  const r = pairTransfers([
    leg({ id: "usaa", txnDate: "2026-07-13", amount: -300 }),
    leg({ id: "disc", accountId: DISCOVER, txnDate: "2026-07-10", amount: 300 }),
  ]);
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].lagDays, 3);
  assert.equal(r.pairs[0].occurredOn, "2026-07-10");
});

test("identifies the outflow leg regardless of input order", () => {
  const forward = pairTransfers([
    leg({ id: "bank" }),
    leg({ id: "card", accountId: CARD, amount: 2142.57 }),
  ]);
  const reversed = pairTransfers([
    leg({ id: "card", accountId: CARD, amount: 2142.57 }),
    leg({ id: "bank" }),
  ]);
  assert.deepEqual(forward.pairs, reversed.pairs);
});

test("rejects a counterparty outside the 3-day window", () => {
  const r = pairTransfers([
    leg({ id: "bank", txnDate: "2026-07-21" }),
    leg({ id: "card", accountId: CARD, txnDate: "2026-07-28", amount: 2142.57 }),
  ]);
  assert.equal(r.pairs.length, 0);
  assert.deepEqual(r.unpairedIds.sort(), ["bank", "card"]);
});

test("never pairs two legs of the same account", () => {
  // A same-account opposite pair is a refund, or the accepted sheet<->CSV duplication —
  // in neither case is it the two ends of one movement.
  const r = pairTransfers([
    leg({ id: "a", amount: -600 }),
    leg({ id: "b", amount: 600 }),
  ]);
  assert.equal(r.pairs.length, 0);
  assert.equal(r.unpairedIds.length, 2);
});

test("refuses to guess when two identical movements compete", () => {
  // Two $600 transfers a day apart: every leg has two candidates, so any pairing is a
  // coin flip. All four are surfaced instead of silently resolved.
  const r = pairTransfers([
    leg({ id: "out1", txnDate: "2026-07-10", amount: -600 }),
    leg({ id: "out2", txnDate: "2026-07-11", amount: -600 }),
    leg({ id: "in1", accountId: CARD, txnDate: "2026-07-10", amount: 600 }),
    leg({ id: "in2", accountId: CARD, txnDate: "2026-07-11", amount: 600 }),
  ]);
  assert.equal(r.pairs.length, 0);
  assert.equal(r.ambiguous.length, 4);
  assert.equal(r.ambiguous[0].candidateIds.length, 2);
});

test("requires the choice to be mutual, not just one-sided", () => {
  // "solo" has exactly one candidate (hub), but hub can also match "rival" — so from
  // hub's side the choice is not unique and nothing may be linked.
  const r = pairTransfers([
    leg({ id: "hub", accountId: CARD, txnDate: "2026-07-11", amount: 600 }),
    leg({ id: "solo", txnDate: "2026-07-10", amount: -600 }),
    leg({ id: "rival", accountId: DISCOVER, txnDate: "2026-07-12", amount: -600 }),
  ]);
  assert.equal(r.pairs.length, 0);
  assert.equal(r.ambiguous.length, 3);
});

test("reports legs whose counterparty is outside the ledger", () => {
  // The majority case: 607 of 763 real legs. Marcus and Bonvenu are not in this ledger,
  // so these can never pair — but they still must not count as spending.
  const r = pairTransfers([
    leg({ id: "marcus", amount: -5000 }),
    leg({ id: "bonvenu", amount: -1200, txnDate: "2026-07-02" }),
  ]);
  assert.equal(r.pairs.length, 0);
  assert.equal(r.ambiguous.length, 0);
  assert.deepEqual(r.unpairedIds.sort(), ["bonvenu", "marcus"]);
});

test("ignores zero-amount rows rather than matching them to each other", () => {
  const r = pairTransfers([
    leg({ id: "z1", amount: 0 }),
    leg({ id: "z2", accountId: CARD, amount: 0 }),
  ]);
  assert.equal(r.pairs.length, 0);
  assert.equal(r.unpairedIds.length, 0, "a zero row is not an unpaired transfer either");
});

test("tolerates float drift from numeric(14,2) round-tripping", () => {
  const r = pairTransfers([
    leg({ id: "bank", amount: -0.1 - 0.2 }),
    leg({ id: "card", accountId: CARD, amount: 0.3 }),
  ]);
  assert.equal(r.pairs.length, 1);
});
