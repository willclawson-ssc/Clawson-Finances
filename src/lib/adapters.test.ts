/**
 * Unit tests for the CSV adapters — format detection, sign handling, occurrence
 * ordinals, and the wrong-account guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAdapter, parseRows, accountTypeWarning } from "./adapters";

const usaa = (rows: Record<string, string>[]) => rows;

test("detects each institution from its header alone", () => {
  assert.equal(detectAdapter(["Date", "Description", "Original Description", "Category", "Amount", "Status"]), "usaa");
  assert.equal(detectAdapter(["Trans. Date", "Post Date", "Description", "Amount", "Category"]), "discover");
  assert.equal(detectAdapter(["Transaction Date", "Clearing Date", "Description", "Merchant", "Category", "Type", "Amount (USD)", "Purchased By"]), "applecard");
  assert.equal(detectAdapter(["Nope", "Wrong"]), null);
});

test("the SAME USAA file yields opposite signs per account type", () => {
  // This is the trap: identical format, opposite semantics. Getting it wrong silently
  // inverts an entire account.
  const rec = usaa([{ Date: "2026-07-01", Description: "ALDI", "Original Description": "ALDI 75107", Category: "Groceries", Amount: "-52.18", Status: "Posted" }]);
  assert.equal(parseRows(rec, "usaa", "asset").rows[0].amount, -52.18);
  assert.equal(parseRows(rec, "usaa", "liability").rows[0].amount, 52.18);
});

test("assigns occurrence ordinals to genuine same-day duplicates", () => {
  // Two real ANTHROPIC $44.00 charges on 2026-06-14 — a naive fingerprint deletes one.
  const rows = parseRows(usaa([
    { Date: "2026-06-14", Description: "ANTHROPIC", "Original Description": "ANTHROPIC", Category: "", Amount: "44.00", Status: "Posted" },
    { Date: "2026-06-14", Description: "ANTHROPIC", "Original Description": "ANTHROPIC", Category: "", Amount: "44.00", Status: "Posted" },
    { Date: "2026-06-14", Description: "ANTHROPIC", "Original Description": "ANTHROPIC", Category: "", Amount: "22.00", Status: "Posted" },
  ]), "usaa", "liability").rows;
  assert.deepEqual(rows.map((r) => r.occurrenceN), [1, 2, 1], "ordinal counts within an identical group only");
});

test("falls back to Description when USAA's Original Description is empty", () => {
  const rows = parseRows(usaa([
    { Date: "2026-07-01", Description: "MCDONALDS", "Original Description": "", Category: "", Amount: "1.85", Status: "Posted" },
  ]), "usaa", "liability").rows;
  assert.equal(rows[0].rawDescription, "MCDONALDS");
});

test("maps USAA status, including scheduled bill payments", () => {
  const mk = (Status: string) => parseRows(usaa([
    { Date: "2026-07-01", Description: "X", "Original Description": "X", Category: "", Amount: "1.00", Status },
  ]), "usaa", "liability").rows[0].status;
  assert.equal(mk("Posted"), "posted");
  assert.equal(mk("Pending"), "pending");
  assert.equal(mk("Recurring Scheduled (Bill) Payment"), "scheduled");
});

test("captures Apple Card's Type and Purchased By", () => {
  const rows = parseRows([{
    "Transaction Date": "07/20/2026", "Clearing Date": "07/21/2026",
    Description: "ALDI 75107 2900 MEADOW CREEK DR", Merchant: "Aldi 75107",
    Category: "Grocery", Type: "Purchase", "Amount (USD)": "43.12", "Purchased By": "Mary Allred",
  }], "applecard", "liability").rows;
  assert.equal(rows[0].txnType, "Purchase");
  assert.equal(rows[0].purchasedBy, "Mary Allred");
  assert.equal(rows[0].postDate, "2026-07-21");
  assert.equal(rows[0].amount, -43.12);
});

test("skips unusable rows instead of importing garbage", () => {
  const { rows, skipped } = parseRows(usaa([
    { Date: "", Description: "", "Original Description": "", Category: "", Amount: "", Status: "" },
    { Date: "2026-07-01", Description: "OK", "Original Description": "OK", Category: "", Amount: "5.00", Status: "Posted" },
  ]), "usaa", "liability");
  assert.equal(rows.length, 1);
  assert.equal(skipped.length, 1);
});

test("warns when a file is imported into the wrong kind of account", () => {
  // A card export dropped into a checking account inverts every amount silently.
  const card = Array.from({ length: 50 }, (_, i) => ({
    Date: "2026-07-01", Description: `M${i}`, "Original Description": `M${i}`,
    Category: "", Amount: "20.00", Status: "Posted",
  }));
  const asLiability = parseRows(usaa(card), "usaa", "liability").rows;
  const asAsset = parseRows(usaa(card), "usaa", "asset").rows;

  assert.equal(accountTypeWarning(asLiability, "USAA Credit Card"), null, "correct pairing is silent");
  assert.match(String(accountTypeWarning(asAsset, "USAA Checking")), /money IN/);
});

test("stays silent on samples too small to judge", () => {
  const few = parseRows(usaa([
    { Date: "2026-07-01", Description: "X", "Original Description": "X", Category: "", Amount: "-5.00", Status: "Posted" },
  ]), "usaa", "asset").rows;
  assert.equal(accountTypeWarning(few, "USAA Checking"), null);
});
