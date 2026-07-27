/**
 * Unit tests for merchant/amount/date normalization.
 *
 * Cases are drawn from the REAL exports, not invented: each one corresponds to a defect
 * that actually occurred (see ~/docs/finances-app.md §3 and the CHANGELOG). A test that
 * only exercises tidy input would have caught none of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMerchant, normalizeAmount, parseAmount, parseDate } from "./normalize";

test("collapses Amazon's per-purchase random tokens", () => {
  // 120 distinct raw descriptors collapsed to 6 on the real USAA card export.
  const a = normalizeMerchant("AMAZON MKTPL*V98087A63 AMZN.COM/BILLWA18O7YA8SW4E");
  const b = normalizeMerchant("AMAZON MKTPL*BV09G6WG0 AMZN.COM/BILLWA");
  assert.equal(a, b, "two Amazon purchases must normalize alike");
  assert.match(a, /AMAZON/);
});

test("keeps the merchant when the descriptor is only a domain", () => {
  // Deleting URL tokens outright erased AMAZON.COM itself — a real regression.
  assert.match(normalizeMerchant("AMAZON.COM/BILL"), /AMAZON/);
});

test("keeps store numbers attached to a name rather than eating the name", () => {
  // An order-ID rule once stripped RACEWAY6935 and left 102 rows as a bare city name.
  assert.match(normalizeMerchant("RACEWAY6935 BOSSIER CITY LA"), /RACEWAY/);
});

test("PayPal's star means the opposite of Amazon's — keep what follows it", () => {
  // Deleting *TOKEN turned PAYPAL *PARAMNTPLUS into the bare state code "CA".
  const out = normalizeMerchant("PAYPAL *PARAMNTPLUS 402-935-7733 CA");
  assert.match(out, /PARAMNTPLUS/);
  assert.notEqual(out.trim(), "CA");
});

test("never returns an empty merchant", () => {
  // A blank would collapse unrelated vendors into one bucket.
  assert.notEqual(normalizeMerchant("*** 123 ***").trim(), "");
  assert.equal(normalizeMerchant(""), "UNKNOWN");
});

test("sign normalization keys off account type, not the institution", () => {
  // USAA exports checking and card in an IDENTICAL format with OPPOSITE semantics.
  assert.equal(normalizeAmount(-25.51, "asset"), -25.51, "checking purchase stays negative");
  assert.equal(normalizeAmount(25.51, "liability"), -25.51, "card purchase flips to negative");
  assert.equal(normalizeAmount(-2142.57, "liability"), 2142.57, "card payment flips to inflow");
});

test("parseAmount handles currency, thousands and accounting negatives", () => {
  assert.equal(parseAmount("$1,234.56"), 1234.56);
  assert.equal(parseAmount("(12.34)"), -12.34);
  assert.equal(parseAmount("-12.34"), -12.34);
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount("icloud storage"), null, "text in an amount cell is not 0");
});

test("parseDate accepts both export formats and rejects junk", () => {
  assert.equal(parseDate("2026-07-24"), "2026-07-24"); // USAA
  assert.equal(parseDate("07/13/2026"), "2026-07-13"); // Discover / Apple
  assert.equal(parseDate("7/3/2026"), "2026-07-03");
  assert.equal(parseDate("2/25/26"), null, "two-digit years are ambiguous here");
  assert.equal(parseDate(""), null);
});

test("parseDate does not shift the day backwards in a negative-offset timezone", () => {
  // new Date('2026-07-24') parses as UTC and prints as the 23rd in America/Chicago.
  assert.equal(parseDate("2026-07-24"), "2026-07-24");
});
