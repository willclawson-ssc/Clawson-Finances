import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { sql, listAccounts } from "@/lib/db";

// Routes are public by default in this Clerk setup, so every handler protects itself.
async function requireUser() {
  const { userId } = await auth();
  return userId;
}

export async function GET() {
  if (!(await requireUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ accounts: await listAccounts() });
}

export async function POST(req: Request) {
  if (!(await requireUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const name = String(body?.name ?? "").trim();
  const institution = String(body?.institution ?? "").trim();
  const type = body?.type;
  const supportsCsv = body?.supportsCsv !== false;

  if (!name || !institution) {
    return NextResponse.json({ error: "name and institution are required" }, { status: 400 });
  }
  // account_type drives sign normalization for every future import, so it is never
  // inferred — a wrong value silently inverts an entire account's spend.
  if (type !== "asset" && type !== "liability") {
    return NextResponse.json({ error: "type must be 'asset' or 'liability'" }, { status: 400 });
  }

  try {
    const rows = (await sql`
      INSERT INTO accounts (name, institution, type, supports_csv)
      VALUES (${name}, ${institution}, ${type}::account_type, ${supportsCsv})
      RETURNING id, name, institution, type, supports_csv, active
    `) as Record<string, unknown>[];
    return NextResponse.json({ account: rows[0] }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("duplicate key")) {
      return NextResponse.json({ error: `an account named "${name}" already exists` }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
