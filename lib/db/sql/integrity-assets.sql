-- Fixed assets: posted depreciation and disposals are permanent records; the
-- only change allowed is marking them reversed (with a reversing entry).

CREATE OR REPLACE FUNCTION gb_depreciation_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gb_purging() THEN
    RETURN coalesce(new, old);
  END IF;
  IF tg_op = 'DELETE' THEN
    IF old.status <> 'draft' THEN
      RAISE EXCEPTION 'posted depreciation cannot be deleted; reverse the run' USING ERRCODE = 'P0001';
    END IF;
    RETURN old;
  END IF;
  IF old.status = 'reversed' THEN
    RAISE EXCEPTION 'reversed depreciation stays reversed' USING ERRCODE = 'P0001';
  END IF;
  IF old.status = 'posted' AND (new.status <> 'reversed' OR (new.asset_id, new.period_end, new.amount, new.run_id) IS DISTINCT FROM (old.asset_id, old.period_end, old.amount, old.run_id)) THEN
    RAISE EXCEPTION 'posted depreciation is permanent; reverse the run' USING ERRCODE = 'P0001';
  END IF;
  RETURN new;
END $$;
--> statement-breakpoint

CREATE TRIGGER depreciation_run_lines_guard BEFORE UPDATE OR DELETE ON depreciation_run_lines
  FOR EACH ROW EXECUTE FUNCTION gb_depreciation_line_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION gb_asset_disposal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gb_purging() THEN
    RETURN coalesce(new, old);
  END IF;
  IF tg_op = 'DELETE' THEN
    RAISE EXCEPTION 'a disposal is permanent; reverse it' USING ERRCODE = 'P0001';
  END IF;
  IF (new.asset_id, new.disposal_date, new.proceeds, new.cost_removed, new.accumulated_removed, new.gain_loss) IS DISTINCT FROM
     (old.asset_id, old.disposal_date, old.proceeds, old.cost_removed, old.accumulated_removed, old.gain_loss) THEN
    RAISE EXCEPTION 'a disposal''s amounts cannot change' USING ERRCODE = 'P0001';
  END IF;
  IF old.status = 'reversed' AND new.status <> 'reversed' THEN
    RAISE EXCEPTION 'a reversed disposal stays reversed' USING ERRCODE = 'P0001';
  END IF;
  RETURN new;
END $$;
--> statement-breakpoint

CREATE TRIGGER asset_disposals_guard BEFORE UPDATE OR DELETE ON asset_disposals
  FOR EACH ROW EXECUTE FUNCTION gb_asset_disposal_guard();
