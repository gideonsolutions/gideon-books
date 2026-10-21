-- Integrity rules the database enforces itself, so that no code path — a
-- bug, a script, a hand-run query — can break them. The application checks
-- the same rules first and explains them; these are the backstop.
--
-- A session may set gideon.allow_purge = 'on' (SET LOCAL, inside the one
-- transaction that deletes a whole organization at its owner's request);
-- nothing else bypasses these triggers.

-- ── Journal entries ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION gb_purging() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('gideon.allow_purge', true), '') = 'on'
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION gb_journal_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_count integer;
  v_sum numeric;
  v_period record;
  v_lock date;
BEGIN
  IF tg_op = 'DELETE' THEN
    IF old.status = 'posted' AND NOT gb_purging() THEN
      RAISE EXCEPTION 'posted journal entry % cannot be deleted; reverse it instead', old.entry_number USING ERRCODE = 'P0001';
    END IF;
    RETURN old;
  END IF;

  IF tg_op = 'INSERT' THEN
    IF new.status <> 'draft' THEN
      RAISE EXCEPTION 'journal entries are inserted as drafts and then posted' USING ERRCODE = 'P0001';
    END IF;
    RETURN new;
  END IF;

  -- UPDATE
  IF old.status = 'posted' THEN
    RAISE EXCEPTION 'posted journal entry % is immutable; reverse it instead', old.entry_number USING ERRCODE = 'P0001';
  END IF;

  IF new.status = 'posted' THEN
    SELECT count(*), coalesce(sum(base_amount), 0) INTO v_count, v_sum
      FROM journal_lines WHERE org_id = new.org_id AND entry_id = new.id;
    IF v_count < 2 THEN
      RAISE EXCEPTION 'journal entry needs at least two lines to post' USING ERRCODE = 'P0001';
    END IF;
    IF v_sum <> 0 THEN
      RAISE EXCEPTION 'journal entry does not balance: base amounts sum to %', v_sum USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_period FROM fiscal_periods WHERE org_id = new.org_id AND id = new.period_id;
    IF NOT FOUND OR v_period.status <> 'open' THEN
      RAISE EXCEPTION 'the period for % is closed', new.entry_date USING ERRCODE = 'P0001';
    END IF;
    IF new.entry_date < v_period.start_date OR new.entry_date > v_period.end_date THEN
      RAISE EXCEPTION 'entry date % is outside its period', new.entry_date USING ERRCODE = 'P0001';
    END IF;
    SELECT lock_date INTO v_lock FROM organizations WHERE id = new.org_id;
    IF v_lock IS NOT NULL AND new.entry_date <= v_lock THEN
      RAISE EXCEPTION 'the books are locked through %', v_lock USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
      SELECT 1 FROM journal_lines l JOIN accounts a ON a.org_id = l.org_id AND a.id = l.account_id
      WHERE l.org_id = new.org_id AND l.entry_id = new.id AND a.is_archived
    ) THEN
      RAISE EXCEPTION 'journal entry posts to an archived account' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN new;
END $$;
--> statement-breakpoint

CREATE TRIGGER journal_entries_guard
  BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION gb_journal_entry_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION gb_journal_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF gb_purging() THEN
    RETURN coalesce(new, old);
  END IF;
  IF tg_op IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO v_status FROM journal_entries WHERE org_id = old.org_id AND id = old.entry_id;
    IF v_status = 'posted' THEN
      RAISE EXCEPTION 'lines of a posted journal entry are immutable' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF tg_op IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO v_status FROM journal_entries WHERE org_id = new.org_id AND id = new.entry_id;
    IF v_status = 'posted' THEN
      RAISE EXCEPTION 'lines cannot be added to a posted journal entry' USING ERRCODE = 'P0001';
    END IF;
    RETURN new;
  END IF;
  RETURN old;
END $$;
--> statement-breakpoint

CREATE TRIGGER journal_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION gb_journal_line_guard();
--> statement-breakpoint

-- ── Append-only records ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION gb_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gb_purging() THEN
    RETURN coalesce(old, new);
  END IF;
  RAISE EXCEPTION '% is append-only', tg_table_name USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint

CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION gb_append_only();
--> statement-breakpoint
CREATE TRIGGER cash_basis_lines_append_only BEFORE UPDATE OR DELETE ON cash_basis_lines
  FOR EACH ROW EXECUTE FUNCTION gb_append_only();
--> statement-breakpoint
CREATE TRIGGER period_events_append_only BEFORE UPDATE OR DELETE ON period_events
  FOR EACH ROW EXECUTE FUNCTION gb_append_only();
--> statement-breakpoint

-- Stock moves: only the link to the cost entry may be filled in, once.
CREATE OR REPLACE FUNCTION gb_stock_move_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gb_purging() THEN
    RETURN coalesce(new, old);
  END IF;
  IF tg_op = 'DELETE' THEN
    RAISE EXCEPTION 'stock moves are permanent; record a reversing move' USING ERRCODE = 'P0001';
  END IF;
  IF old.journal_entry_id IS NULL
     AND (new.item_id, new.location_id, new.move_date, new.kind, new.quantity, new.value, new.qty_on_hand_after, new.value_after)
         IS NOT DISTINCT FROM (old.item_id, old.location_id, old.move_date, old.kind, old.quantity, old.value, old.qty_on_hand_after, old.value_after) THEN
    RETURN new;
  END IF;
  RAISE EXCEPTION 'stock moves are permanent; record a reversing move' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint

CREATE TRIGGER stock_moves_guard BEFORE UPDATE OR DELETE ON stock_moves
  FOR EACH ROW EXECUTE FUNCTION gb_stock_move_guard();
--> statement-breakpoint

-- Settlements: the amounts never change; the only change is to reversed.
CREATE OR REPLACE FUNCTION gb_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gb_purging() THEN
    RETURN coalesce(new, old);
  END IF;
  IF tg_op = 'DELETE' THEN
    RAISE EXCEPTION 'settlements are permanent; reverse one instead' USING ERRCODE = 'P0001';
  END IF;
  IF (new.debit_item_id, new.credit_item_id, new.amount, new.debit_base, new.credit_base, new.settlement_date, new.currency)
     IS DISTINCT FROM (old.debit_item_id, old.credit_item_id, old.amount, old.debit_base, old.credit_base, old.settlement_date, old.currency) THEN
    RAISE EXCEPTION 'a settlement''s amounts cannot change' USING ERRCODE = 'P0001';
  END IF;
  IF old.status = 'reversed' AND new.status <> 'reversed' THEN
    RAISE EXCEPTION 'a reversed settlement stays reversed' USING ERRCODE = 'P0001';
  END IF;
  IF old.journal_entry_id IS NOT NULL AND new.journal_entry_id IS DISTINCT FROM old.journal_entry_id THEN
    RAISE EXCEPTION 'a settlement''s entry cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN new;
END $$;
--> statement-breakpoint

CREATE TRIGGER settlements_guard BEFORE UPDATE OR DELETE ON settlements
  FOR EACH ROW EXECUTE FUNCTION gb_settlement_guard();
--> statement-breakpoint

-- Payments: a recorded payment's amounts never change; it can only be voided.
CREATE OR REPLACE FUNCTION gb_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gb_purging() THEN
    RETURN coalesce(new, old);
  END IF;
  IF tg_op = 'DELETE' THEN
    IF old.journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'a recorded payment cannot be deleted; void it' USING ERRCODE = 'P0001';
    END IF;
    RETURN old;
  END IF;
  IF (new.kind, new.contact_id, new.payment_date, new.account_id, new.currency, new.amount, new.fx_rate, new.base_amount, new.fee_amount)
     IS DISTINCT FROM (old.kind, old.contact_id, old.payment_date, old.account_id, old.currency, old.amount, old.fx_rate, old.base_amount, old.fee_amount) THEN
    RAISE EXCEPTION 'a recorded payment''s amounts cannot change; void it and record it again' USING ERRCODE = 'P0001';
  END IF;
  IF old.status = 'void' AND new.status <> 'void' THEN
    RAISE EXCEPTION 'a void payment stays void' USING ERRCODE = 'P0001';
  END IF;
  RETURN new;
END $$;
--> statement-breakpoint

CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION gb_payment_guard();
--> statement-breakpoint

-- Issued documents: what was posted cannot change; status moves on.
CREATE OR REPLACE FUNCTION gb_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gb_purging() THEN
    RETURN coalesce(new, old);
  END IF;
  IF old.kind NOT IN ('invoice','credit_note','write_off','sales_receipt','bill','vendor_credit','expense') OR old.status = 'draft' THEN
    RETURN coalesce(new, old);
  END IF;
  IF tg_op = 'DELETE' THEN
    RAISE EXCEPTION 'an issued document cannot be deleted; void it' USING ERRCODE = 'P0001';
  END IF;
  IF (new.kind, new.contact_id, new.issue_date, new.posting_date, new.currency, new.fx_rate, new.subtotal, new.discount_total, new.tax_total, new.total, new.base_total, new.journal_entry_id, new.number)
     IS DISTINCT FROM (old.kind, old.contact_id, old.issue_date, old.posting_date, old.currency, old.fx_rate, old.subtotal, old.discount_total, old.tax_total, old.total, old.base_total, old.journal_entry_id, old.number) THEN
    RAISE EXCEPTION 'an issued document cannot be edited; void it or issue a credit' USING ERRCODE = 'P0001';
  END IF;
  IF old.status = 'void' AND new.status <> 'void' THEN
    RAISE EXCEPTION 'a void document stays void' USING ERRCODE = 'P0001';
  END IF;
  RETURN new;
END $$;
--> statement-breakpoint

CREATE TRIGGER documents_guard BEFORE UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION gb_document_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION gb_document_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_doc record;
BEGIN
  IF gb_purging() THEN
    RETURN coalesce(new, old);
  END IF;
  SELECT kind, status INTO v_doc FROM documents WHERE org_id = coalesce(new.org_id, old.org_id) AND id = coalesce(new.document_id, old.document_id);
  IF NOT FOUND OR v_doc.status = 'draft' OR v_doc.kind NOT IN ('invoice','credit_note','write_off','sales_receipt','bill','vendor_credit','expense') THEN
    RETURN coalesce(new, old);
  END IF;
  IF tg_op = 'UPDATE'
     AND (new.item_id, new.quantity, new.unit_price, new.account_id, new.net_amount, new.tax_amount, new.gross_amount, new.document_discount)
         IS NOT DISTINCT FROM (old.item_id, old.quantity, old.unit_price, old.account_id, old.net_amount, old.tax_amount, old.gross_amount, old.document_discount) THEN
    RETURN new;
  END IF;
  RAISE EXCEPTION 'lines of an issued document cannot change' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint

CREATE TRIGGER document_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON document_lines
  FOR EACH ROW EXECUTE FUNCTION gb_document_line_guard();
