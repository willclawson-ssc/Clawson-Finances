/**
 * Exercise the CSV adapters against Will's REAL exports in ~/docker/finances-app/samples/.
 * Those files hold live financial data and are mode 600 OUTSIDE this repo — this script
 * prints aggregates only, never row contents.
 *
 * Run: npx tsx scripts/test-adapters.ts
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Papa from "papaparse";
import { detectAdapter, parseRows, type AccountType } from "../src/lib/adapters";

const SAMPLES = path.join(os.homedir(), "docker/finances-app/samples");

const FILES: { file: string; accountType: AccountType; label: string }[] = [
  { file: "usaa-sample-A.csv", accountType: "asset", label: "USAA checking" },
  { file: "usaa-sample-B.csv", accountType: "liability", label: "USAA card" },
  { file: "discover-sample.csv", accountType: "liability", label: "Discover" },
  { file: "applecard-sample.csv", accountType: "liability", label: "Apple Card" },
];

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

for (const { file, accountType, label } of FILES) {
  const full = path.join(SAMPLES, file);
  console.log(`\n${label}  (${file})`);
  if (!fs.existsSync(full)) {
    console.log("  SKIPPED (file missing)");
    continue;
  }

  const parsed = Papa.parse<Record<string, string>>(fs.readFileSync(full, "utf8"), {
    header: true,
    skipEmptyLines: true,
  });
  const adapter = detectAdapter(parsed.meta.fields ?? []);
  check(adapter !== null, `adapter detected: ${adapter}`);
  if (!adapter) continue;

  const { rows, skipped } = parseRows(parsed.data, adapter, accountType);
  const out = rows.filter((r) => r.amount < 0).length;
  const inn = rows.filter((r) => r.amount > 0).length;
  const repeats = rows.filter((r) => r.occurrenceN > 1).length;
  const distinct = new Set(rows.map((r) => r.normalizedMerchant)).size;

  console.log(
    `  rows=${rows.length} skipped=${skipped.length} out=${out} in=${inn} ` +
      `distinctMerchants=${distinct} repeatRows=${repeats}`,
  );
  if (skipped.length) console.log(`  first skip: ${skipped[0].reason}`);

  check(rows.length > 0, "parsed at least one row");
  check(
    rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.txnDate)),
    "all dates ISO-formatted",
  );
  // Ledger convention (negative = money out) must hold on every account.
  check(out > inn, "spending outnumbers inflows — sign normalized correctly");

  const amazon = rows.filter((r) => r.normalizedMerchant.includes("AMAZON"));
  if (amazon.length) {
    const rawDistinct = new Set(amazon.map((r) => r.rawDescription)).size;
    const normDistinct = new Set(amazon.map((r) => r.normalizedMerchant)).size;
    console.log(`  amazon rows=${amazon.length} raw=${rawDistinct} normalized=${normDistinct}`);
    check(normDistinct < rawDistinct, "normalization collapses Amazon's per-purchase tokens");
  }
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
