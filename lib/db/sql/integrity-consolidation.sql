-- Entity groups: the group's audit trail is append-only, and eliminations
-- are never edited (a wrong one is voided and replaced).
CREATE TRIGGER group_audit_events_append_only BEFORE UPDATE OR DELETE ON group_audit_events
  FOR EACH ROW EXECUTE FUNCTION gb_append_only();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION gb_elimination_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gb_purging() THEN
    RETURN coalesce(new, old);
  END IF;
  RAISE EXCEPTION 'elimination lines are permanent; void the elimination instead' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint

CREATE TRIGGER elimination_lines_guard BEFORE UPDATE OR DELETE ON elimination_lines
  FOR EACH ROW EXECUTE FUNCTION gb_elimination_line_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION gb_elimination_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF gb_purging() THEN
    RETURN coalesce(new, old);
  END IF;
  IF tg_op = 'DELETE' THEN
    RAISE EXCEPTION 'eliminations are permanent; void one instead' USING ERRCODE = 'P0001';
  END IF;
  IF (new.entry_date, new.description, new.group_id) IS DISTINCT FROM (old.entry_date, old.description, old.group_id) THEN
    RAISE EXCEPTION 'an elimination cannot be edited; void it and record a new one' USING ERRCODE = 'P0001';
  END IF;
  IF old.status = 'void' AND new.status <> 'void' THEN
    RAISE EXCEPTION 'a void elimination stays void' USING ERRCODE = 'P0001';
  END IF;
  RETURN new;
END $$;
--> statement-breakpoint

CREATE TRIGGER elimination_entries_guard BEFORE UPDATE OR DELETE ON elimination_entries
  FOR EACH ROW EXECUTE FUNCTION gb_elimination_entry_guard();
