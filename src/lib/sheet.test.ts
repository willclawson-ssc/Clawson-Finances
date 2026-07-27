/**
 * Unit tests for the Google Sheet adapter — dirty, hand-typed data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalCategory, repairDate, ledgerAmount, parseSheetRows } from "./sheet";

test("canonicalizes 62 sheet category strings onto the 24-name taxonomy", () => {
  assert.equal(canonicalCategory("Food (Restaurants)"), "Food (Restaurants)");
  assert.equal(canonicalCategory("food (restaurants)"), "Food (Restaurants)", "case folding");
  assert.equal(canonicalCategory("Food (Restauants)"), "Food (Restaurants)", "known typo");
  assert.equal(canonicalCategory("Utlities"), "Utilities");
  assert.equal(canonicalCategory("misc inome"), "MISC Income");
  assert.equal(canonicalCategory(""), null);
});

test("refuses to guess at categories that are not typos of anything", () => {
  // Wrong category is worse than blank: these go to the review queue.
  for (const s of ["inspection", "home", "business income"]) {
    assert.equal(canonicalCategory(s), null, `${s} must not be guessed`);
  }
});

test("repairs impossible years from the Form timestamp", () => {
  const r = repairDate("3/1/0024", "3/5/2024 14:23:08");
  assert.equal(r.date, "2024-03-05");
  assert.equal(r.flag, "date_year_repaired");
});

test("repairs plausible-but-wrong years — same month/day, one year behind", () => {
  // "8/10/2022" submitted 8/10/2023. Exactly 365 days off; looks legitimate.
  const r = repairDate("8/10/2022", "8/10/2023 7:33:50");
  assert.equal(r.date, "2023-08-10");
  assert.equal(r.flag, "date_year_repaired");
});

test("leaves genuine back-entry alone", () => {
  // Different month/day = a real (if late) entry, not a year typo. Must not be rewritten.
  const r = repairDate("6/2/2025", "8/10/2025 7:33:50");
  assert.equal(r.date, "2025-06-02");
  assert.equal(r.flag, undefined);
});

test("accepts two-digit years, which the CSV adapters reject", () => {
  assert.equal(repairDate("2/25/26", "").date, "2026-02-25");
});

test("direction comes from Income/Expense, and a negative flips it", () => {
  assert.equal(ledgerAmount(43.12, "Expense").amount, -43.12);
  assert.equal(ledgerAmount(1167.32, "Income").amount, 1167.32);
  // A negative Expense is how Will recorded refunds: money back in.
  const refund = ledgerAmount(-31.28, "Expense");
  assert.equal(refund.amount, 31.28);
  assert.equal(refund.flag, "negative_amount", "flagged, because 4 of 15 are ambiguous");
});

const row = (o: Record<string, string>) => ({
  Timestamp: "", Date: "7/1/2025", "Payee/Remitter": "Aldi", "Description ": "groceries",
  Amount: "43.12", "Method of Payment": "USAA Visa", Category: "Food (Groceries)",
  "Income or Expense?": "Expense", ...o,
});

test("maps 14 payment-method spellings onto 7 accounts", () => {
  const m = (v: string) => parseSheetRows([row({ "Method of Payment": v })]).rows[0]?.accountKey;
  assert.equal(m("USAA Visa"), "usaa_visa");
  assert.equal(m("usaa visa"), "usaa_visa");
  assert.equal(m("USAA  Checking"), "usaa_checking", "double space");
  // Will confirmed these overlapping labels are the same account.
  assert.equal(m("Checking Account"), "usaa_checking");
  assert.equal(m("Dad's checking"), "dads_checking", "apostrophe");
});

test("skips blank spacer rows and text-in-amount rows, keeps everything else", () => {
  const { rows, skipped } = parseSheetRows([
    row({}),
    { Timestamp: "", Date: "", "Payee/Remitter": "", "Description ": "", Amount: "", "Method of Payment": "", Category: "", "Income or Expense?": "" },
    row({ Amount: "icloud storage" }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].reason, /blank/);
});

test("keeps the raw category string alongside the canonical one", () => {
  const r = parseSheetRows([row({ Category: "food (groceries)" })]).rows[0];
  assert.equal(r.category, "Food (Groceries)");
  assert.equal(r.sourceCategory, "food (groceries)", "the typed string survives for audit");
});

test("flags an unmappable category rather than dropping the row", () => {
  const r = parseSheetRows([row({ Category: "inspection" })]).rows[0];
  assert.equal(r.category, null);
  assert.ok(r.flags.includes("unmapped_category"));
});

test("rejects an unknown payment method instead of guessing an account", () => {
  const { rows, skipped } = parseSheetRows([row({ "Method of Payment": "Some Other Bank" })]);
  assert.equal(rows.length, 0);
  assert.match(skipped[0].reason, /unknown payment method/);
});
