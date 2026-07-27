import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  getTransaction, mergeCandidates, mergeTransactions, unmergeTransactions,
} from "@/lib/transactions";

export const runtime = "nodejs";

/** Duplicate candidates for this transaction. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const txn = await getTransaction(id);
  if (!txn) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({ candidates: await mergeCandidates(txn.id) });
}

/**
 * Merge another transaction INTO this one. This transaction survives; the other keeps its
 * id and provenance and is hidden from the ledger, so the merge is fully reversible.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const survivor = await getTransaction(id);
  if (!survivor) return NextResponse.json({ error: "not found" }, { status: 404 });

  let body: { mergeId?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.mergeId) return NextResponse.json({ error: "mergeId is required" }, { status: 400 });

  const loser = await getTransaction(body.mergeId);
  if (!loser) return NextResponse.json({ error: "transaction to merge not found" }, { status: 404 });

  try {
    const result = await mergeTransactions(survivor.id, loser.id, userId, body.reason);
    return NextResponse.json({ ...result, transaction: await getTransaction(survivor.id) });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 422 });
  }
}

/** Undo a merge. Body: { mergeRecordId }. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await params;

  let body: { mergeRecordId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.mergeRecordId) {
    return NextResponse.json({ error: "mergeRecordId is required" }, { status: 400 });
  }

  try {
    await unmergeTransactions(body.mergeRecordId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 422 });
  }
}
