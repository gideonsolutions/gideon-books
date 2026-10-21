import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { listBankTransactions, suggestionsForMany, type Suggestion, type TxnFilters } from "@/lib/banking/transactions";
import { moneyAccountOptions } from "@/lib/web/options";
import { dateParam, intParam, readParams, type SearchParams } from "@/lib/web/params";
import { formatMoney } from "@/lib/money/format";
import { EmptyState, FilterBar, FilterField, LinkButton, PageHeader, Pagination, inputClass } from "@/components/ui";
import { Options } from "@/components/client/forms";
import { ReviewTable, type ReviewRow } from "@/components/banking/review-table";
import { bulkAcceptAction, bulkExcludeAction, confirmReviewedAction } from "../actions";

export const metadata = { title: "Bank transactions" };

function describe(s: Suggestion): { type: string; label: string; quick: boolean } {
  switch (s.type) {
    case "match":
      return { type: "match", label: `${s.line.description}${s.line.entryNumber ? ` (#${s.line.entryNumber}, ${s.line.entryDate})` : ""}`, quick: true };
    case "rule":
      return { type: "rule", label: s.rule.name, quick: true };
    case "transfer":
      return { type: "transfer", label: `from/to ${s.accountName}`, quick: false };
    case "invoice":
    case "bill":
      return { type: s.type, label: `${s.number ?? ""} ${s.contactName} — ${formatMoney(s.openAmount, s.currency)} open`, quick: false };
  }
}

export default async function Transactions({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const db = getDb();
  const status = (["review", "unreviewed", "matched", "categorized", "excluded", "all"].includes(sp.status ?? "") ? sp.status : "review") as TxnFilters["status"];
  const page = intParam(sp.page, 1);
  const { rows, total, pageSize } = await listBankTransactions(db, ctx.orgId, {
    accountId: sp.account || undefined,
    status,
    from: dateParam(sp.from),
    to: dateParam(sp.to),
    q: sp.q,
    page,
    sort: (sp.sort as TxnFilters["sort"]) ?? "date_desc",
  });
  const suggestions = await suggestionsForMany(db, ctx, rows.map((r) => r.txn).filter((t) => t.status === "unreviewed"));
  const base = `/o/${org}`;
  const reviewRows: ReviewRow[] = rows.map(({ txn, accountName }) => {
    const top = suggestions.get(txn.id)?.[0];
    const matches = suggestions.get(txn.id)?.filter((x) => x.type === "match").length ?? 0;
    const d = top ? describe(top) : null;
    return {
      id: txn.id,
      date: txn.postedDate,
      accountName,
      description: txn.description,
      payee: txn.payee,
      amount: txn.amount,
      currency: txn.currency,
      status: txn.status,
      autoCategorized: txn.autoCategorized && !txn.reviewedAt,
      possibleDuplicate: !!txn.possibleDuplicateOfId && txn.status === "unreviewed",
      suggestion: txn.status !== "unreviewed" ? { type: txn.status, label: txn.autoCategorized ? "posted by a rule" : "", quick: false } : d ? { ...d, quick: d.quick && (top!.type === "rule" || matches === 1) } : null,
    };
  });
  return (
    <>
      <PageHeader
        title="Bank transactions"
        description="Each transaction the bank reported, waiting to be matched to the books, categorized, recorded as a payment or transfer, or excluded. Nothing is posted until you say so (or a rule you allowed to post does)."
        actions={
          can(ctx, "banking.import") && (
            <LinkButton variant="secondary" href={`${base}/banking/imports/new${sp.account ? `?account=${sp.account}` : ""}`}>
              Import a statement
            </LinkButton>
          )
        }
      />
      <FilterBar>
        <FilterField label="Account">
          <select name="account" defaultValue={sp.account ?? ""} className={inputClass}>
            <option value="">All accounts</option>
            <Options options={await moneyAccountOptions(db, ctx.orgId)} />
          </select>
        </FilterField>
        <FilterField label="Show">
          <select name="status" defaultValue={status} className={inputClass}>
            <option value="review">Waiting for review</option>
            <option value="matched">Matched</option>
            <option value="categorized">Categorized</option>
            <option value="excluded">Excluded</option>
            <option value="all">All</option>
          </select>
        </FilterField>
        <FilterField label="From">
          <input type="date" name="from" defaultValue={sp.from} className={inputClass} />
        </FilterField>
        <FilterField label="To">
          <input type="date" name="to" defaultValue={sp.to} className={inputClass} />
        </FilterField>
        <FilterField label="Search">
          <input name="q" defaultValue={sp.q} placeholder="Description, payee, reference" className={inputClass} />
        </FilterField>
        <FilterField label="Sort">
          <select name="sort" defaultValue={sp.sort ?? "date_desc"} className={inputClass}>
            <option value="date_desc">Newest first</option>
            <option value="date_asc">Oldest first</option>
            <option value="amount_desc">Largest in first</option>
            <option value="amount_asc">Largest out first</option>
          </select>
        </FilterField>
      </FilterBar>
      {reviewRows.length === 0 ? (
        <EmptyState
          title={status === "review" ? "Nothing waiting for review" : "No transactions match"}
          action={can(ctx, "banking.import") && <LinkButton href={`${base}/banking/imports/new`}>Import a statement</LinkButton>}
        >
          {status === "review" ? "Every bank transaction is matched, categorized or excluded. New ones arrive when you import a statement or a feed syncs." : "Try different filters."}
        </EmptyState>
      ) : (
        <>
          <ReviewTable
            rows={reviewRows}
            base={base}
            accept={bulkAcceptAction.bind(null, org)}
            exclude={bulkExcludeAction.bind(null, org)}
            confirm={confirmReviewedAction.bind(null, org, [])}
            canAct={can(ctx, "banking.categorize")}
          />
          <Pagination page={page} pageSize={pageSize} total={total} params={sp} />
        </>
      )}
    </>
  );
}
