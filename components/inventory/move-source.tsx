import Link from "next/link";
import type { stockMoves } from "@/lib/db/schema/inventory";

type Move = typeof stockMoves.$inferSelect;

const KIND_LABELS: Record<Move["kind"], string> = {
  opening: "Opening stock",
  receipt: "Received",
  sale: "Sold",
  sale_return: "Returned by customer",
  purchase_return: "Returned to vendor",
  transfer_out: "Transferred out",
  transfer_in: "Transferred in",
  adjustment: "Adjustment",
  revaluation: "Revaluation",
};

/** What a stock move was, linked to the record that made it. */
export function MoveSourceLink({ base, move }: { base: string; move: Move }) {
  const label = KIND_LABELS[move.kind] + (move.reversesMoveId ? " (reversal)" : "");
  const href =
    move.sourceType === "document" || move.sourceType === "document_void"
      ? `${base}/documents/${move.sourceId}`
      : move.sourceType === "stock_adjustment" || move.sourceType === "stock_transfer"
        ? `${base}/inventory/movements/${move.sourceId}`
        : move.sourceType === "purchase_receipt"
          ? `${base}/purchases/goods-received/${move.sourceId}`
          : null;
  return (
    <span>
      {href ? (
        <Link className="text-brand-700 hover:underline" href={href}>
          {label}
        </Link>
      ) : (
        label
      )}
      {move.reason && <span className="block text-xs text-slate-500">{move.reason}</span>}
    </span>
  );
}
