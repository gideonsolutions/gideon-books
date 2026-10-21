/** Period-close checks contributed by the fixed-assets module (see lib/ledger/close-checks.ts). */
import type { CloseCheck } from "@/lib/ledger/close-checks";
import { unpostedDepreciation } from "./depreciation";

export const assetsCloseChecks: CloseCheck = async (db, ctx, period) => {
  const missing = await unpostedDepreciation(db, ctx, period.endDate);
  return [
    {
      key: "depreciation_posted",
      title: "Depreciation posted for the period",
      status: missing.length === 0 ? "pass" : "fail",
      severity: "warning",
      ...(missing.length
        ? {
            detail: `${missing.length} asset${missing.length === 1 ? " has" : "s have"} depreciation due through ${period.endDate} that is not posted (${missing
              .slice(0, 3)
              .map((m) => m.asset.number)
              .join(", ")}${missing.length > 3 ? ", …" : ""}).`,
            href: "/assets/depreciation",
          }
        : {}),
    },
  ];
};
