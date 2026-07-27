import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  getTransaction, getEditHistory, getReceipts, getMergedInto, applyEdits,
} from "@/lib/transactions";

export const runtime = "nodejs";

/** `id` accepts either the uuid or the TXN-000123 handle. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const txn = await getTransaction(id);
  if (!txn) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [edits, receipts, merged] = await Promise.all([
    getEditHistory(txn.id), getReceipts(txn.id), getMergedInto(txn.id),
  ]);
  return NextResponse.json({ transaction: txn, edits, receipts, merged });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const txn = await getTransaction(id);
  if (!txn) return NextResponse.json({ error: "not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { note, ...patch } = body;

  try {
    // editedBy is the Clerk user id: the audit trail is worthless if it can't say who.
    const result = await applyEdits(txn.id, patch, userId, typeof note === "string" ? note : undefined);
    const updated = await getTransaction(txn.id);
    return NextResponse.json({ ...result, transaction: updated });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 422 });
  }
}
