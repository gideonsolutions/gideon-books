-- Banking integrity rules (see lib/db/schema/banking.ts). Self-contained:
-- does not depend on functions from integrity.sql, so it can be applied in
-- any order. gideon.allow_purge = 'on' (organization deletion) bypasses them.

-- Import rows are kept exactly as received.
CREATE OR REPLACE FUNCTION gb_bank_import_rows_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('gideon.allow_purge', true), '') = 'on' THEN
    RETURN coalesce(new, old);
  END IF;
  RAISE EXCEPTION 'bank import rows are append-only' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint

CREATE TRIGGER bank_import_rows_append_only BEFORE UPDATE OR DELETE ON bank_import_rows
  FOR EACH ROW EXECUTE FUNCTION gb_bank_import_rows_guard();
--> statement-breakpoint

-- What the bank reported never changes; only its review state does.
CREATE OR REPLACE FUNCTION gb_bank_transaction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('gideon.allow_purge', true), '') = 'on' THEN
    RETURN coalesce(new, old);
  END IF;
  IF tg_op = 'DELETE' THEN
    RAISE EXCEPTION 'bank transactions are kept; remove them by undoing their import' USING ERRCODE = 'P0001';
  END IF;
  IF (new.account_id, new.posted_date, new.amount, new.currency, new.description, new.external_id, new.fingerprint, new.batch_id, new.raw_row_id)
     IS DISTINCT FROM (old.account_id, old.posted_date, old.amount, old.currency, old.description, old.external_id, old.fingerprint, old.batch_id, old.raw_row_id) THEN
    RAISE EXCEPTION 'what the bank reported cannot be edited' USING ERRCODE = 'P0001';
  END IF;
  IF old.status = 'removed' AND new.status <> 'removed' THEN
    RAISE EXCEPTION 'a removed bank transaction stays removed; import it again' USING ERRCODE = 'P0001';
  END IF;
  RETURN new;
END $$;
--> statement-breakpoint

CREATE TRIGGER bank_transactions_guard BEFORE UPDATE OR DELETE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION gb_bank_transaction_guard();
--> statement-breakpoint

-- A completed reconciliation's figures are final; it can only be undone.
CREATE OR REPLACE FUNCTION gb_reconciliation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('gideon.allow_purge', true), '') = 'on' THEN
    RETURN coalesce(new, old);
  END IF;
  IF tg_op = 'DELETE' THEN
    IF old.status <> 'in_progress' THEN
      RAISE EXCEPTION 'a completed reconciliation cannot be deleted; undo it' USING ERRCODE = 'P0001';
    END IF;
    RETURN old;
  END IF;
  IF old.status = 'completed' THEN
    IF new.status NOT IN ('completed', 'undone')
       OR (new.statement_date, new.statement_balance, new.opening_balance, new.cleared_balance, new.difference, new.adjustment_entry_id)
          IS DISTINCT FROM (old.statement_date, old.statement_balance, old.opening_balance, old.cleared_balance, old.difference, old.adjustment_entry_id) THEN
      RAISE EXCEPTION 'a completed reconciliation is final; undo it to change it' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF old.status = 'undone' THEN
    RAISE EXCEPTION 'an undone reconciliation stays undone' USING ERRCODE = 'P0001';
  END IF;
  RETURN new;
END $$;
--> statement-breakpoint

CREATE TRIGGER reconciliations_guard BEFORE UPDATE OR DELETE ON reconciliations
  FOR EACH ROW EXECUTE FUNCTION gb_reconciliation_guard();
