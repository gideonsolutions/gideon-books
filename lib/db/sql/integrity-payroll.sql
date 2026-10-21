-- Payroll: a posted run's figures and lines are permanent; a run is corrected
-- by voiding it (its entry is reversed) and importing again.

CREATE OR REPLACE FUNCTION gb_payroll_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gb_purging() THEN
    RETURN coalesce(new, old);
  END IF;
  IF tg_op = 'DELETE' THEN
    RAISE EXCEPTION 'a payroll run cannot be deleted; void it' USING ERRCODE = 'P0001';
  END IF;
  IF (new.provider, new.provider_run_id, new.pay_date, new.gross_wages, new.employee_withholdings, new.employee_deductions, new.employer_taxes, new.employer_benefits, new.reimbursements, new.net_pay)
     IS DISTINCT FROM (old.provider, old.provider_run_id, old.pay_date, old.gross_wages, old.employee_withholdings, old.employee_deductions, old.employer_taxes, old.employer_benefits, old.reimbursements, old.net_pay) THEN
    RAISE EXCEPTION 'a payroll run''s figures cannot change; void it and import again' USING ERRCODE = 'P0001';
  END IF;
  IF old.journal_entry_id IS NOT NULL AND new.journal_entry_id IS DISTINCT FROM old.journal_entry_id THEN
    RAISE EXCEPTION 'a payroll run''s entry cannot change' USING ERRCODE = 'P0001';
  END IF;
  IF old.status = 'void' AND new.status <> 'void' THEN
    RAISE EXCEPTION 'a void payroll run stays void' USING ERRCODE = 'P0001';
  END IF;
  RETURN new;
END $$;
--> statement-breakpoint

CREATE TRIGGER payroll_runs_guard BEFORE UPDATE OR DELETE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION gb_payroll_run_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION gb_payroll_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gb_purging() THEN
    RETURN coalesce(new, old);
  END IF;
  RAISE EXCEPTION 'payroll run lines are permanent' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint

CREATE TRIGGER payroll_run_lines_guard BEFORE UPDATE OR DELETE ON payroll_run_lines
  FOR EACH ROW EXECUTE FUNCTION gb_payroll_line_guard();
