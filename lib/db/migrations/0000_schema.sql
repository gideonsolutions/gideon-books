CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"role" text NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"origin" text DEFAULT 'upload' NOT NULL,
	"external_ref" text,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "attachments_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"actor_user_id" uuid,
	"actor_type" text NOT NULL,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"source" text NOT NULL,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb,
	"ip" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"provider" text NOT NULL,
	"to_address" text NOT NULL,
	"cc_address" text,
	"from_address" text NOT NULL,
	"reply_to" text,
	"subject" text NOT NULL,
	"text_body" text NOT NULL,
	"html_body" text,
	"attachment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"org_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "idempotency_keys_org_id_scope_key_pk" PRIMARY KEY("org_id","scope","key")
);
--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"display_name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_enc" text,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"dedupe_key" text,
	"result" jsonb,
	"progress" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "number_sequences" (
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"next_value" integer DEFAULT 1 NOT NULL,
	"padding" integer DEFAULT 4 NOT NULL,
	CONSTRAINT "number_sequences_org_id_key_pk" PRIMARY KEY("org_id","key")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"base_currency" text NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"fiscal_year_start_month" integer DEFAULT 1 NOT NULL,
	"reporting_basis" text DEFAULT 'accrual' NOT NULL,
	"books_start_date" date,
	"lock_date" date,
	"is_demo" boolean DEFAULT false NOT NULL,
	"entity_type" text DEFAULT 'llc' NOT NULL,
	"tax_rounding" text DEFAULT 'line' NOT NULL,
	"bank_rules_auto_post" boolean DEFAULT false NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "org_fy_month" CHECK ("organizations"."fiscal_year_start_month" between 1 and 12),
	CONSTRAINT "org_slug_format" CHECK ("organizations"."slug" ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"pending_mfa" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "user_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"totp_secret_enc" text,
	"totp_enabled_at" timestamp with time zone,
	"is_instance_admin" boolean DEFAULT false NOT NULL,
	"email_verified_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"connection_id" uuid,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"signature_verified" boolean NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"subtype" text NOT NULL,
	"parent_id" uuid,
	"description" text,
	"currency" text,
	"system_key" text,
	"control" text,
	"cash_flow_section" text,
	"intercompany_org_id" uuid,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "accounts_org_code_uq" UNIQUE("org_id","code"),
	CONSTRAINT "accounts_not_own_parent" CHECK ("accounts"."parent_id" is null or "accounts"."parent_id" <> "accounts"."id")
);
--> statement-breakpoint
CREATE TABLE "bank_account_details" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"institution" text,
	"mask" text,
	"account_kind" text NOT NULL,
	"feed_connection_id" uuid,
	"feed_account_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_persons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"role" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_persons_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"company_name" text,
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_vendor" boolean DEFAULT false NOT NULL,
	"is_employee" boolean DEFAULT false NOT NULL,
	"is_beneficiary" boolean DEFAULT false NOT NULL,
	"email" text,
	"phone" text,
	"website" text,
	"currency" text,
	"payment_terms_id" uuid,
	"billing_address" jsonb,
	"shipping_address" jsonb,
	"tax_exempt" boolean DEFAULT false NOT NULL,
	"tax_exemption_reason" text,
	"tax_exemption_certificate" text,
	"is_1099" boolean DEFAULT false NOT NULL,
	"default_income_account_id" uuid,
	"default_expense_account_id" uuid,
	"notes" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "dimension_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"parent_id" uuid,
	"restriction" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dimension_values_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "dimension_values_org_kind_name_uq" UNIQUE("org_id","kind","name"),
	CONSTRAINT "dimension_fund_restriction" CHECK (("dimension_values"."kind" = 'fund') = ("dimension_values"."restriction" is not null))
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"base_currency" text NOT NULL,
	"rate_date" date NOT NULL,
	"rate" numeric(28, 12) NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"fetched_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_rates_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "exchange_rates_positive" CHECK ("exchange_rates"."rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "fiscal_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"fiscal_year_id" uuid NOT NULL,
	"period_no" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	CONSTRAINT "fiscal_periods_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "fiscal_periods_org_start_uq" UNIQUE("org_id","start_date")
);
--> statement-breakpoint
CREATE TABLE "fiscal_years" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_years_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "fiscal_years_org_start_uq" UNIQUE("org_id","start_date"),
	CONSTRAINT "fiscal_years_range" CHECK ("fiscal_years"."end_date" > "fiscal_years"."start_date")
);
--> statement-breakpoint
CREATE TABLE "inventory_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_locations_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "inventory_locations_org_code_uq" UNIQUE("org_id","code")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"sku" text,
	"name" text NOT NULL,
	"description" text,
	"unit" text DEFAULT 'ea' NOT NULL,
	"sale_price" numeric(28, 8),
	"purchase_cost" numeric(28, 8),
	"income_account_id" uuid,
	"expense_account_id" uuid,
	"inventory_account_id" uuid,
	"sale_tax_code_id" uuid,
	"purchase_tax_code_id" uuid,
	"reorder_level" numeric(20, 6),
	"reorder_quantity" numeric(20, 6),
	"preferred_vendor_id" uuid,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "items_stock_accounts" CHECK ("items"."kind" <> 'stock' or ("items"."inventory_account_id" is not null and "items"."expense_account_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_number" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"kind" text NOT NULL,
	"entry_date" date NOT NULL,
	"document_date" date,
	"period_id" uuid,
	"description" text DEFAULT '' NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"source_ref" text,
	"idempotency_key" text,
	"request_hash" text,
	"cash_basis" text DEFAULT 'as_is' NOT NULL,
	"reverses_entry_id" uuid,
	"reversal_reason" text,
	"auto_reverse_on" date,
	"is_adjusting" boolean DEFAULT false NOT NULL,
	"origin" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	CONSTRAINT "journal_entries_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "journal_entries_posted_numbered" CHECK ("journal_entries"."status" = 'draft' or ("journal_entries"."entry_number" is not null and "journal_entries"."period_id" is not null and "journal_entries"."posted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"description" text,
	"base_amount" numeric(24, 4) NOT NULL,
	"currency" text NOT NULL,
	"txn_amount" numeric(24, 4) NOT NULL,
	"fx_rate" numeric(28, 12) DEFAULT '1' NOT NULL,
	"exchange_rate_id" uuid,
	"contact_id" uuid,
	"open_item_type" text,
	"open_item_id" uuid,
	"item_id" uuid,
	"quantity" numeric(20, 6),
	"project_id" uuid,
	"class_id" uuid,
	"department_id" uuid,
	"location_id" uuid,
	"fund_id" uuid,
	"trust_component" text,
	"beneficiary_id" uuid,
	"tax_rate_id" uuid,
	"source_line_id" uuid,
	"billable_status" text,
	CONSTRAINT "journal_lines_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "journal_lines_entry_line_uq" UNIQUE("entry_id","line_no"),
	CONSTRAINT "journal_lines_open_item_pair" CHECK (("journal_lines"."open_item_type" is null) = ("journal_lines"."open_item_id" is null)),
	CONSTRAINT "journal_lines_fx_positive" CHECK ("journal_lines"."fx_rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"days_due" integer NOT NULL,
	"discount_rate" numeric(12, 8),
	"discount_days" integer,
	"is_archived" boolean DEFAULT false NOT NULL,
	CONSTRAINT "payment_terms_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "payment_terms_org_name_uq" UNIQUE("org_id","name")
);
--> statement-breakpoint
CREATE TABLE "period_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"checklist" jsonb,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"customer_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"billing_method" text DEFAULT 'time_and_materials' NOT NULL,
	"hourly_rate" numeric(28, 8),
	"fixed_fee" numeric(24, 4),
	"budget_amount" numeric(24, 4),
	"start_date" date,
	"end_date" date,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "projects_org_name_uq" UNIQUE("org_id","name")
);
--> statement-breakpoint
CREATE TABLE "tax_code_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"tax_code_id" uuid NOT NULL,
	"jurisdiction_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"is_compound" boolean DEFAULT false NOT NULL,
	CONSTRAINT "tax_code_components_seq_uq" UNIQUE("org_id","tax_code_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "tax_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_exempt" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_codes_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "tax_codes_org_name_uq" UNIQUE("org_id","name")
);
--> statement-breakpoint
CREATE TABLE "tax_jurisdictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"authority_contact_id" uuid,
	"liability_account_id" uuid NOT NULL,
	"recoverable_account_id" uuid,
	"filing_frequency" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_jurisdictions_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "tax_jurisdictions_org_name_uq" UNIQUE("org_id","name")
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"jurisdiction_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rate" numeric(12, 8) NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"source_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rates_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "tax_rates_range" CHECK ("tax_rates"."rate" >= 0 and "tax_rates"."rate" < 1),
	CONSTRAINT "tax_rates_dates" CHECK ("tax_rates"."effective_to" is null or "tax_rates"."effective_to" >= "tax_rates"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "cash_basis_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"source_entry_id" uuid NOT NULL,
	"source_line_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"base_amount" numeric(24, 4) NOT NULL,
	"currency" text NOT NULL,
	"txn_amount" numeric(24, 4) NOT NULL,
	"contact_id" uuid,
	"item_id" uuid,
	"project_id" uuid,
	"class_id" uuid,
	"department_id" uuid,
	"location_id" uuid,
	"fund_id" uuid,
	"trust_component" text,
	"beneficiary_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_line_taxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_line_id" uuid NOT NULL,
	"jurisdiction_id" uuid NOT NULL,
	"tax_rate_id" uuid NOT NULL,
	"rate" numeric(12, 8) NOT NULL,
	"sequence" integer NOT NULL,
	"is_compound" boolean NOT NULL,
	"taxable_amount" numeric(24, 4) NOT NULL,
	"tax_amount" numeric(24, 4) NOT NULL,
	"is_recoverable" boolean DEFAULT false NOT NULL,
	"is_exempt" boolean DEFAULT false NOT NULL,
	"account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "document_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"line_type" text DEFAULT 'item' NOT NULL,
	"item_id" uuid,
	"description" text DEFAULT '' NOT NULL,
	"quantity" numeric(20, 6) DEFAULT '1' NOT NULL,
	"unit_price" numeric(28, 8) DEFAULT '0' NOT NULL,
	"discount_rate" numeric(12, 8),
	"document_discount" numeric(24, 4) DEFAULT '0' NOT NULL,
	"account_id" uuid,
	"tax_code_id" uuid,
	"net_amount" numeric(24, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(24, 4) DEFAULT '0' NOT NULL,
	"gross_amount" numeric(24, 4) DEFAULT '0' NOT NULL,
	"service_date" date,
	"project_id" uuid,
	"class_id" uuid,
	"department_id" uuid,
	"location_id" uuid,
	"fund_id" uuid,
	"trust_component" text,
	"beneficiary_id" uuid,
	"inventory_location_id" uuid,
	"billable_customer_id" uuid,
	"billed_on_line_id" uuid,
	"received_quantity" numeric(20, 6) DEFAULT '0' NOT NULL,
	"billed_quantity" numeric(20, 6) DEFAULT '0' NOT NULL,
	"source_line_id" uuid,
	"return_of_line_id" uuid,
	CONSTRAINT "document_lines_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "document_lines_doc_line_uq" UNIQUE("document_id","line_no")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"side" text NOT NULL,
	"number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"contact_id" uuid,
	"issue_date" date NOT NULL,
	"posting_date" date,
	"due_date" date,
	"expiry_date" date,
	"payment_terms_id" uuid,
	"currency" text NOT NULL,
	"fx_rate" numeric(28, 12) DEFAULT '1' NOT NULL,
	"exchange_rate_id" uuid,
	"tax_inclusive" boolean DEFAULT false NOT NULL,
	"discount_type" text,
	"discount_value" numeric(28, 8),
	"subtotal" numeric(24, 4) DEFAULT '0' NOT NULL,
	"discount_total" numeric(24, 4) DEFAULT '0' NOT NULL,
	"tax_total" numeric(24, 4) DEFAULT '0' NOT NULL,
	"total" numeric(24, 4) DEFAULT '0' NOT NULL,
	"base_total" numeric(24, 4) DEFAULT '0' NOT NULL,
	"reference" text,
	"memo" text,
	"notes" text,
	"billing_address" jsonb,
	"shipping_address" jsonb,
	"cash_account_id" uuid,
	"inventory_location_id" uuid,
	"journal_entry_id" uuid,
	"source_document_id" uuid,
	"recurring_template_id" uuid,
	"is_opening_balance" boolean DEFAULT false NOT NULL,
	"is_reimbursement" boolean DEFAULT false NOT NULL,
	"issued_at" timestamp with time zone,
	"issued_by" uuid,
	"sent_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"void_entry_id" uuid,
	"branding_snapshot" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "documents_side_matches_kind" CHECK (("documents"."side" = 'sales') = ("documents"."kind" in ('estimate','invoice','credit_note','write_off','sales_receipt'))),
	CONSTRAINT "documents_fx_positive" CHECK ("documents"."fx_rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"number" text,
	"contact_id" uuid NOT NULL,
	"payment_date" date NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(24, 4) NOT NULL,
	"fx_rate" numeric(28, 12) DEFAULT '1' NOT NULL,
	"exchange_rate_id" uuid,
	"base_amount" numeric(24, 4) NOT NULL,
	"fee_amount" numeric(24, 4) DEFAULT '0' NOT NULL,
	"fee_account_id" uuid,
	"method" text DEFAULT 'other' NOT NULL,
	"reference" text,
	"memo" text,
	"status" text DEFAULT 'posted' NOT NULL,
	"journal_entry_id" uuid,
	"void_entry_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"provider" text,
	"provider_ref" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_fee_nonnegative" CHECK ("payments"."fee_amount" >= 0 and "payments"."fee_amount" < "payments"."amount")
);
--> statement-breakpoint
CREATE TABLE "recurring_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"occurrence_date" date NOT NULL,
	"status" text NOT NULL,
	"document_id" uuid,
	"journal_entry_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_runs_once_uq" UNIQUE("template_id","occurrence_date")
);
--> statement-breakpoint
CREATE TABLE "recurring_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"frequency" text NOT NULL,
	"interval" integer DEFAULT 1 NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"next_run_date" date,
	"max_occurrences" integer,
	"occurrences" integer DEFAULT 0 NOT NULL,
	"auto_issue" boolean DEFAULT false NOT NULL,
	"auto_send" boolean DEFAULT false NOT NULL,
	"template" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_templates_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"settlement_date" date NOT NULL,
	"side" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"debit_item_type" text NOT NULL,
	"debit_item_id" uuid NOT NULL,
	"credit_item_type" text NOT NULL,
	"credit_item_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(24, 4) NOT NULL,
	"debit_base" numeric(24, 4) NOT NULL,
	"credit_base" numeric(24, 4) NOT NULL,
	"fx_difference_base" numeric(24, 4) DEFAULT '0' NOT NULL,
	"journal_entry_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversal_entry_id" uuid,
	"reversal_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlements_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "settlements_amount_positive" CHECK ("settlements"."amount" > 0),
	CONSTRAINT "settlements_distinct_items" CHECK ("settlements"."debit_item_id" <> "settlements"."credit_item_id")
);
--> statement-breakpoint
CREATE TABLE "item_costs" (
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"qty_on_hand" numeric(20, 6) DEFAULT '0' NOT NULL,
	"total_value" numeric(24, 4) DEFAULT '0' NOT NULL,
	"last_move_date" date,
	"move_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_costs_org_id_item_id_pk" PRIMARY KEY("org_id","item_id"),
	CONSTRAINT "item_costs_nonnegative" CHECK ("item_costs"."qty_on_hand" >= 0),
	CONSTRAINT "item_costs_zero_value_at_zero_qty" CHECK ("item_costs"."qty_on_hand" > 0 or "item_costs"."total_value" = 0)
);
--> statement-breakpoint
CREATE TABLE "item_stock" (
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"qty_on_hand" numeric(20, 6) DEFAULT '0' NOT NULL,
	"reorder_level" numeric(20, 6),
	CONSTRAINT "item_stock_org_id_item_id_location_id_pk" PRIMARY KEY("org_id","item_id","location_id"),
	CONSTRAINT "item_stock_nonnegative" CHECK ("item_stock"."qty_on_hand" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"seq" bigserial NOT NULL,
	"item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"move_date" date NOT NULL,
	"kind" text NOT NULL,
	"quantity" numeric(20, 6) NOT NULL,
	"value" numeric(24, 4) NOT NULL,
	"unit_cost_after" numeric(28, 8),
	"qty_on_hand_after" numeric(20, 6) NOT NULL,
	"value_after" numeric(24, 4) NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"source_line_id" uuid,
	"journal_entry_id" uuid,
	"reverses_move_id" uuid,
	"transfer_group_id" uuid,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_moves_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "stock_moves_on_hand_nonnegative" CHECK ("stock_moves"."qty_on_hand_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" text NOT NULL,
	"kind" text NOT NULL,
	"movement_date" date NOT NULL,
	"reason" text NOT NULL,
	"from_location_id" uuid,
	"to_location_id" uuid,
	"offset_account_id" uuid,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "inventory_movements_org_number_uq" UNIQUE("org_id","number")
);
--> statement-breakpoint
CREATE TABLE "po_bill_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"bill_line_id" uuid NOT NULL,
	"po_line_id" uuid NOT NULL,
	"billed_quantity" numeric(20, 6) NOT NULL,
	"matched_quantity" numeric(20, 6) NOT NULL,
	"received_with_bill" numeric(20, 6) DEFAULT '0' NOT NULL,
	"grni_value" numeric(24, 4) DEFAULT '0' NOT NULL,
	"variance_value" numeric(24, 4) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "po_bill_matches_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "po_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reopened_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "purchase_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"po_line_id" uuid NOT NULL,
	"item_id" uuid,
	"quantity" numeric(20, 6) NOT NULL,
	"value" numeric(24, 4) DEFAULT '0' NOT NULL,
	"stock_move_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_receipt_lines_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "purchase_receipt_lines_qty_positive" CHECK ("purchase_receipt_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" text NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"receipt_date" date NOT NULL,
	"location_id" uuid NOT NULL,
	"journal_entry_id" uuid,
	"status" text DEFAULT 'posted' NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversal_entry_id" uuid,
	"reversal_reason" text,
	"memo" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_receipts_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "purchase_receipts_org_number_uq" UNIQUE("org_id","number")
);
--> statement-breakpoint
CREATE TABLE "receipt_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"linked_attachment_id" uuid,
	"matched_by" uuid,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unmatched_at" timestamp with time zone,
	"unmatched_by" uuid,
	CONSTRAINT "receipt_matches_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "bank_csv_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"account_id" uuid,
	"config" jsonb NOT NULL,
	"header_signature" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_csv_mappings_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "bank_csv_mappings_org_name_uq" UNIQUE("org_id","name")
);
--> statement-breakpoint
CREATE TABLE "bank_feed_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_account_id" text NOT NULL,
	"name" text NOT NULL,
	"institution" text,
	"currency" text,
	"balance" numeric(24, 4),
	"balance_date" date,
	"linked_account_id" uuid,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_feed_accounts_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "bank_feed_accounts_external_uq" UNIQUE("org_id","connection_id","external_account_id")
);
--> statement-breakpoint
CREATE TABLE "bank_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"source" text NOT NULL,
	"file_name" text,
	"file_sha256" text,
	"attachment_id" uuid,
	"mapping_id" uuid,
	"mapping_snapshot" jsonb,
	"connection_id" uuid,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by" uuid,
	"undo_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_import_batches_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "bank_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_import_rows_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "bank_match_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"entry_id" uuid,
	"rule_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by" uuid,
	"undo_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_match_groups_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "bank_match_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"bank_transaction_id" uuid,
	"journal_line_id" uuid,
	"amount" numeric(24, 4) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "bank_match_items_one_side" CHECK (("bank_match_items"."bank_transaction_id" is null) <> ("bank_match_items"."journal_line_id" is null))
);
--> statement-breakpoint
CREATE TABLE "bank_rule_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"bank_transaction_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"entry_id" uuid,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"priority" integer NOT NULL,
	"conditions" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"mode" text DEFAULT 'suggest' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"editor_may_autopost" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_rules_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"posted_date" date NOT NULL,
	"amount" numeric(24, 4) NOT NULL,
	"currency" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"payee" text,
	"reference" text,
	"bank_balance" numeric(24, 4),
	"external_id" text,
	"fingerprint" text NOT NULL,
	"batch_id" uuid,
	"raw_row_id" uuid,
	"possible_duplicate_of_id" uuid,
	"status" text DEFAULT 'unreviewed' NOT NULL,
	"status_reason" text,
	"rule_id" uuid,
	"auto_categorized" boolean DEFAULT false NOT NULL,
	"match_group_id" uuid,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transactions_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "reconciliation_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"journal_line_id" uuid NOT NULL,
	"amount" numeric(24, 4) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"statement_date" date NOT NULL,
	"statement_balance" numeric(24, 4) NOT NULL,
	"opening_balance" numeric(24, 4) NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"cleared_balance" numeric(24, 4),
	"difference" numeric(24, 4),
	"adjustment_entry_id" uuid,
	"adjustment_reason" text,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"undone_by" uuid,
	"undone_at" timestamp with time zone,
	"undo_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliations_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "asset_disposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"disposal_date" date NOT NULL,
	"proceeds" numeric(24, 4) DEFAULT '0' NOT NULL,
	"proceeds_account_id" uuid,
	"cost_removed" numeric(24, 4) NOT NULL,
	"accumulated_removed" numeric(24, 4) NOT NULL,
	"gain_loss" numeric(24, 4) NOT NULL,
	"reason" text,
	"status" text DEFAULT 'posted' NOT NULL,
	"journal_entry_id" uuid,
	"reversal_entry_id" uuid,
	"reversal_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_disposals_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "asset_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"auto_post_depreciation" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_tax_books" (
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"method" text NOT NULL,
	"method_label" text,
	"tax_basis" numeric(24, 4) NOT NULL,
	"useful_life_months" integer,
	"declining_factor" numeric(12, 8),
	"placed_in_service" date NOT NULL,
	"notes" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_tax_books_org_id_asset_id_pk" PRIMARY KEY("org_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "asset_tax_depreciation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"tax_year_start" date NOT NULL,
	"tax_year_end" date NOT NULL,
	"amount" numeric(24, 4) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_tax_depreciation_year_uq" UNIQUE("org_id","asset_id","tax_year_start"),
	CONSTRAINT "asset_tax_depreciation_nonnegative" CHECK ("asset_tax_depreciation"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "depreciation_run_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"period_end" date NOT NULL,
	"amount" numeric(24, 4) NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	CONSTRAINT "depreciation_run_lines_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "depreciation_run_lines_positive" CHECK ("depreciation_run_lines"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "depreciation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"period_end" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"total" numeric(24, 4) DEFAULT '0' NOT NULL,
	"journal_entry_id" uuid,
	"reversal_entry_id" uuid,
	"reversal_reason" text,
	"prepared_by" uuid,
	"prepared_by_label" text,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "depreciation_runs_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "fixed_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"description" text,
	"asset_account_id" uuid NOT NULL,
	"accumulated_depreciation_account_id" uuid NOT NULL,
	"depreciation_expense_account_id" uuid NOT NULL,
	"acquisition_date" date NOT NULL,
	"in_service_date" date NOT NULL,
	"cost" numeric(24, 4) NOT NULL,
	"residual_value" numeric(24, 4) DEFAULT '0' NOT NULL,
	"useful_life_months" integer NOT NULL,
	"method" text NOT NULL,
	"declining_factor" numeric(12, 8),
	"status" text DEFAULT 'draft' NOT NULL,
	"acquisition_type" text NOT NULL,
	"source_document_id" uuid,
	"source_document_line_id" uuid,
	"funding_account_id" uuid,
	"acquisition_entry_id" uuid,
	"capitalized_on" date,
	"opening_accumulated_depreciation" numeric(24, 4) DEFAULT '0' NOT NULL,
	"opening_depreciation_through" date,
	"class_id" uuid,
	"department_id" uuid,
	"location_id" uuid,
	"project_id" uuid,
	"notes" text,
	"disposed_on" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_assets_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "fixed_assets_org_number_uq" UNIQUE("org_id","number"),
	CONSTRAINT "fixed_assets_cost_nonnegative" CHECK ("fixed_assets"."cost" >= 0 and "fixed_assets"."residual_value" >= 0 and "fixed_assets"."residual_value" <= "fixed_assets"."cost"),
	CONSTRAINT "fixed_assets_life" CHECK ("fixed_assets"."useful_life_months" between 1 and 1200),
	CONSTRAINT "fixed_assets_in_service" CHECK ("fixed_assets"."in_service_date" >= "fixed_assets"."acquisition_date")
);
--> statement-breakpoint
CREATE TABLE "payroll_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"adapter" text NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"raw_content" text NOT NULL,
	"status" text DEFAULT 'previewed' NOT NULL,
	"parsed" jsonb,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"run_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_imports_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "payroll_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"component_type" text NOT NULL,
	"component_code" text NOT NULL,
	"label" text,
	"expense_account_id" uuid,
	"liability_account_id" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_mappings_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "payroll_mappings_component_uq" UNIQUE("org_id","component_type","component_code")
);
--> statement-breakpoint
CREATE TABLE "payroll_run_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"employee_ref" text,
	"employee_name" text,
	"contact_id" uuid,
	"component_type" text NOT NULL,
	"component_code" text NOT NULL,
	"amount" numeric(24, 4) NOT NULL,
	"department_id" uuid,
	"class_id" uuid,
	"location_id" uuid,
	"project_id" uuid
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_run_id" text NOT NULL,
	"pay_date" date NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"file_name" text,
	"file_sha256" text,
	"import_id" uuid,
	"employee_count" integer DEFAULT 0 NOT NULL,
	"gross_wages" numeric(24, 4) DEFAULT '0' NOT NULL,
	"employee_withholdings" numeric(24, 4) DEFAULT '0' NOT NULL,
	"employee_deductions" numeric(24, 4) DEFAULT '0' NOT NULL,
	"employer_taxes" numeric(24, 4) DEFAULT '0' NOT NULL,
	"employer_benefits" numeric(24, 4) DEFAULT '0' NOT NULL,
	"reimbursements" numeric(24, 4) DEFAULT '0' NOT NULL,
	"net_pay" numeric(24, 4) DEFAULT '0' NOT NULL,
	"is_adjustment" boolean DEFAULT false NOT NULL,
	"adjusts_run_id" uuid,
	"mapping_snapshot" jsonb,
	"journal_entry_id" uuid,
	"void_entry_id" uuid,
	"void_reason" text,
	"voided_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "payroll_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid,
	"kind" text NOT NULL,
	"settlement_date" date NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"liability_account_id" uuid NOT NULL,
	"amount" numeric(24, 4) NOT NULL,
	"reference" text,
	"memo" text,
	"status" text DEFAULT 'posted' NOT NULL,
	"journal_entry_id" uuid,
	"void_entry_id" uuid,
	"void_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_settlements_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "payroll_settlements_positive" CHECK ("payroll_settlements"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "budget_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid,
	"dimension_value_id" uuid,
	"dimension_key" text DEFAULT '' NOT NULL,
	"period_start" date NOT NULL,
	"amount" numeric(24, 4) NOT NULL,
	CONSTRAINT "budget_lines_cell_uq" UNIQUE("budget_id","account_id","dimension_key","period_start"),
	CONSTRAINT "budget_lines_month_start" CHECK (extract(day from "budget_lines"."period_start") = 1)
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"fiscal_year_start" date NOT NULL,
	"dimension" text,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "budgets_org_name_uq" UNIQUE("org_id","name")
);
--> statement-breakpoint
CREATE TABLE "elimination_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"description" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "elimination_entries_group_id_uq" UNIQUE("group_id","id")
);
--> statement-breakpoint
CREATE TABLE "elimination_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"group_account_id" uuid NOT NULL,
	"amount" numeric(24, 4) NOT NULL,
	"org_id" uuid,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "entity_group_members" (
	"group_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"ownership" numeric(12, 8) DEFAULT '1' NOT NULL,
	"method" text DEFAULT 'full' NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_group_members_group_id_org_id_pk" PRIMARY KEY("group_id","org_id"),
	CONSTRAINT "group_member_ownership" CHECK ("entity_group_members"."ownership" > 0 and "entity_group_members"."ownership" <= 1)
);
--> statement-breakpoint
CREATE TABLE "entity_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"reporting_currency" text NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "group_account_mappings" (
	"group_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"group_account_id" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_account_mappings_group_id_account_id_pk" PRIMARY KEY("group_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "group_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_accounts_code_uq" UNIQUE("group_id","code"),
	CONSTRAINT "group_accounts_group_id_uq" UNIQUE("group_id","id")
);
--> statement-breakpoint
CREATE TABLE "group_audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"rate_date" date NOT NULL,
	"rate" numeric(28, 12) NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_rates_uq" UNIQUE("group_id","currency","rate_date"),
	CONSTRAINT "group_rates_positive" CHECK ("group_rates"."rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "intercompany_pairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"org_a" uuid NOT NULL,
	"account_a" uuid NOT NULL,
	"org_b" uuid NOT NULL,
	"account_b" uuid NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intercompany_distinct_orgs" CHECK ("intercompany_pairs"."org_a" <> "intercompany_pairs"."org_b")
);
--> statement-breakpoint
CREATE TABLE "tax_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"return_type" text NOT NULL,
	"tax_year_start" date NOT NULL,
	"tax_year_end" date NOT NULL,
	"category_code" text NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(24, 4) NOT NULL,
	"description" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "tax_adjustments_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "tax_adjustments_range" CHECK ("tax_adjustments"."tax_year_end" >= "tax_adjustments"."tax_year_start")
);
--> statement-breakpoint
CREATE TABLE "tax_custom_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"return_type" text NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"kind" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_custom_categories_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "tax_custom_categories_code_uq" UNIQUE("org_id","return_type","code")
);
--> statement-breakpoint
CREATE TABLE "tax_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"return_type" text NOT NULL,
	"version_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"basis" text NOT NULL,
	"content_hash" text NOT NULL,
	"source_hash" text NOT NULL,
	"json_attachment_id" uuid,
	"csv_attachment_id" uuid,
	"entry_count" integer NOT NULL,
	"last_entry_number" integer,
	"unmapped_count" integer DEFAULT 0 NOT NULL,
	"summary" jsonb,
	"generated_by" uuid,
	"generated_by_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_exports_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "tax_mapping_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"return_type" text NOT NULL,
	"catalog_tax_year" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_mapping_sets_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "tax_mapping_sets_return_uq" UNIQUE("org_id","return_type")
);
--> statement-breakpoint
CREATE TABLE "tax_mapping_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"locked_at" timestamp with time zone,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_mapping_versions_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "tax_mapping_versions_set_version_uq" UNIQUE("set_id","version")
);
--> statement-breakpoint
CREATE TABLE "tax_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"dimension_kind" text,
	"dimension_value_id" uuid,
	"dimension_key" text DEFAULT '' NOT NULL,
	"category_code" text NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_mappings_cell_uq" UNIQUE("version_id","account_id","dimension_key"),
	CONSTRAINT "tax_mappings_dimension_pair" CHECK (("tax_mappings"."dimension_kind" is null) = ("tax_mappings"."dimension_value_id" is null))
);
--> statement-breakpoint
CREATE TABLE "tax_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"return_type" text NOT NULL,
	"version_id" uuid NOT NULL,
	"tax_year_start" date NOT NULL,
	"tax_year_end" date NOT NULL,
	"basis" text NOT NULL,
	"status" text NOT NULL,
	"data_hash" text NOT NULL,
	"note" text,
	"reviewed_by" uuid,
	"reviewed_by_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"plan_key" text NOT NULL,
	"status" text NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"current_period_end" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"quantity" bigint NOT NULL,
	"ref" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"token" text NOT NULL,
	"provider_session_id" text,
	"url" text NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(24, 4) NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "payment_links_token_uq" UNIQUE("token"),
	CONSTRAINT "payment_links_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "data_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"job_id" uuid,
	"storage_key" text,
	"file_name" text,
	"size_bytes" bigint,
	"sha256" text,
	"manifest" jsonb,
	"result_org_id" uuid,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_billing_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"project_id" uuid,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"amount" numeric(24, 4) NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"user_id" uuid,
	"contact_id" uuid,
	"person_label" text NOT NULL,
	"hours" numeric(8, 2) NOT NULL,
	"rate" numeric(28, 8),
	"billable" boolean DEFAULT true NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_entries_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "time_entries_hours" CHECK ("time_entries"."hours" > 0 and "time_entries"."hours" <= 24)
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_org_id_parent_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","parent_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_account_details" ADD CONSTRAINT "bank_account_details_org_id_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_persons" ADD CONSTRAINT "contact_persons_org_id_contact_id_contacts_org_id_id_fk" FOREIGN KEY ("org_id","contact_id") REFERENCES "public"."contacts"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_id_payment_terms_id_payment_terms_org_id_id_fk" FOREIGN KEY ("org_id","payment_terms_id") REFERENCES "public"."payment_terms"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_id_default_income_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","default_income_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_id_default_expense_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","default_expense_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_values" ADD CONSTRAINT "dimension_values_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_values" ADD CONSTRAINT "dimension_values_org_id_parent_id_dimension_values_org_id_id_fk" FOREIGN KEY ("org_id","parent_id") REFERENCES "public"."dimension_values"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_org_id_fiscal_year_id_fiscal_years_org_id_id_fk" FOREIGN KEY ("org_id","fiscal_year_id") REFERENCES "public"."fiscal_years"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_org_id_income_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","income_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_org_id_expense_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","expense_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_org_id_inventory_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","inventory_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_org_id_sale_tax_code_id_tax_codes_org_id_id_fk" FOREIGN KEY ("org_id","sale_tax_code_id") REFERENCES "public"."tax_codes"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_org_id_purchase_tax_code_id_tax_codes_org_id_id_fk" FOREIGN KEY ("org_id","purchase_tax_code_id") REFERENCES "public"."tax_codes"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_org_id_preferred_vendor_id_contacts_org_id_id_fk" FOREIGN KEY ("org_id","preferred_vendor_id") REFERENCES "public"."contacts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_org_id_period_id_fiscal_periods_org_id_id_fk" FOREIGN KEY ("org_id","period_id") REFERENCES "public"."fiscal_periods"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_org_id_reverses_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","reverses_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_org_id_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_org_id_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_org_id_exchange_rate_id_exchange_rates_org_id_id_fk" FOREIGN KEY ("org_id","exchange_rate_id") REFERENCES "public"."exchange_rates"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_org_id_contact_id_contacts_org_id_id_fk" FOREIGN KEY ("org_id","contact_id") REFERENCES "public"."contacts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_org_id_item_id_items_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_org_id_project_id_projects_org_id_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_org_id_class_id_dimension_values_org_id_id_fk" FOREIGN KEY ("org_id","class_id") REFERENCES "public"."dimension_values"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_org_id_department_id_dimension_values_org_id_id_fk" FOREIGN KEY ("org_id","department_id") REFERENCES "public"."dimension_values"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_org_id_location_id_dimension_values_org_id_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."dimension_values"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_org_id_fund_id_dimension_values_org_id_id_fk" FOREIGN KEY ("org_id","fund_id") REFERENCES "public"."dimension_values"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_org_id_beneficiary_id_contacts_org_id_id_fk" FOREIGN KEY ("org_id","beneficiary_id") REFERENCES "public"."contacts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_org_id_tax_rate_id_tax_rates_org_id_id_fk" FOREIGN KEY ("org_id","tax_rate_id") REFERENCES "public"."tax_rates"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_terms" ADD CONSTRAINT "payment_terms_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_events" ADD CONSTRAINT "period_events_org_id_period_id_fiscal_periods_org_id_id_fk" FOREIGN KEY ("org_id","period_id") REFERENCES "public"."fiscal_periods"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_customer_id_contacts_org_id_id_fk" FOREIGN KEY ("org_id","customer_id") REFERENCES "public"."contacts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_code_components" ADD CONSTRAINT "tax_code_components_org_id_tax_code_id_tax_codes_org_id_id_fk" FOREIGN KEY ("org_id","tax_code_id") REFERENCES "public"."tax_codes"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_code_components" ADD CONSTRAINT "tax_code_components_org_id_jurisdiction_id_tax_jurisdictions_org_id_id_fk" FOREIGN KEY ("org_id","jurisdiction_id") REFERENCES "public"."tax_jurisdictions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_jurisdictions" ADD CONSTRAINT "tax_jurisdictions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_jurisdictions" ADD CONSTRAINT "tax_jurisdictions_org_id_liability_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","liability_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_jurisdictions" ADD CONSTRAINT "tax_jurisdictions_org_id_recoverable_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","recoverable_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_jurisdictions" ADD CONSTRAINT "tax_jurisdictions_org_id_authority_contact_id_contacts_org_id_id_fk" FOREIGN KEY ("org_id","authority_contact_id") REFERENCES "public"."contacts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_org_id_jurisdiction_id_tax_jurisdictions_org_id_id_fk" FOREIGN KEY ("org_id","jurisdiction_id") REFERENCES "public"."tax_jurisdictions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_basis_lines" ADD CONSTRAINT "cash_basis_lines_org_id_settlement_id_settlements_org_id_id_fk" FOREIGN KEY ("org_id","settlement_id") REFERENCES "public"."settlements"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_basis_lines" ADD CONSTRAINT "cash_basis_lines_org_id_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_basis_lines" ADD CONSTRAINT "cash_basis_lines_org_id_source_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","source_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_basis_lines" ADD CONSTRAINT "cash_basis_lines_org_id_source_line_id_journal_lines_org_id_id_fk" FOREIGN KEY ("org_id","source_line_id") REFERENCES "public"."journal_lines"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_basis_lines" ADD CONSTRAINT "cash_basis_lines_org_id_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_line_taxes" ADD CONSTRAINT "document_line_taxes_org_id_document_id_documents_org_id_id_fk" FOREIGN KEY ("org_id","document_id") REFERENCES "public"."documents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_line_taxes" ADD CONSTRAINT "document_line_taxes_org_id_document_line_id_document_lines_org_id_id_fk" FOREIGN KEY ("org_id","document_line_id") REFERENCES "public"."document_lines"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_line_taxes" ADD CONSTRAINT "document_line_taxes_org_id_jurisdiction_id_tax_jurisdictions_org_id_id_fk" FOREIGN KEY ("org_id","jurisdiction_id") REFERENCES "public"."tax_jurisdictions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_line_taxes" ADD CONSTRAINT "document_line_taxes_org_id_tax_rate_id_tax_rates_org_id_id_fk" FOREIGN KEY ("org_id","tax_rate_id") REFERENCES "public"."tax_rates"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_line_taxes" ADD CONSTRAINT "document_line_taxes_org_id_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_org_id_document_id_documents_org_id_id_fk" FOREIGN KEY ("org_id","document_id") REFERENCES "public"."documents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_org_id_item_id_items_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_org_id_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_org_id_tax_code_id_tax_codes_org_id_id_fk" FOREIGN KEY ("org_id","tax_code_id") REFERENCES "public"."tax_codes"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_org_id_project_id_projects_org_id_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_org_id_class_id_dimension_values_org_id_id_fk" FOREIGN KEY ("org_id","class_id") REFERENCES "public"."dimension_values"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_org_id_department_id_dimension_values_org_id_id_fk" FOREIGN KEY ("org_id","department_id") REFERENCES "public"."dimension_values"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_org_id_location_id_dimension_values_org_id_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."dimension_values"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_org_id_fund_id_dimension_values_org_id_id_fk" FOREIGN KEY ("org_id","fund_id") REFERENCES "public"."dimension_values"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_org_id_beneficiary_id_contacts_org_id_id_fk" FOREIGN KEY ("org_id","beneficiary_id") REFERENCES "public"."contacts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_org_id_inventory_location_id_inventory_locations_org_id_id_fk" FOREIGN KEY ("org_id","inventory_location_id") REFERENCES "public"."inventory_locations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_org_id_billable_customer_id_contacts_org_id_id_fk" FOREIGN KEY ("org_id","billable_customer_id") REFERENCES "public"."contacts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_org_id_source_line_id_document_lines_org_id_id_fk" FOREIGN KEY ("org_id","source_line_id") REFERENCES "public"."document_lines"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_org_id_return_of_line_id_document_lines_org_id_id_fk" FOREIGN KEY ("org_id","return_of_line_id") REFERENCES "public"."document_lines"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_contact_id_contacts_org_id_id_fk" FOREIGN KEY ("org_id","contact_id") REFERENCES "public"."contacts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_payment_terms_id_payment_terms_org_id_id_fk" FOREIGN KEY ("org_id","payment_terms_id") REFERENCES "public"."payment_terms"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_exchange_rate_id_exchange_rates_org_id_id_fk" FOREIGN KEY ("org_id","exchange_rate_id") REFERENCES "public"."exchange_rates"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_cash_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","cash_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_inventory_location_id_inventory_locations_org_id_id_fk" FOREIGN KEY ("org_id","inventory_location_id") REFERENCES "public"."inventory_locations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_journal_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","journal_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_void_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","void_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_source_document_id_documents_org_id_id_fk" FOREIGN KEY ("org_id","source_document_id") REFERENCES "public"."documents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_contact_id_contacts_org_id_id_fk" FOREIGN KEY ("org_id","contact_id") REFERENCES "public"."contacts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_fee_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","fee_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_exchange_rate_id_exchange_rates_org_id_id_fk" FOREIGN KEY ("org_id","exchange_rate_id") REFERENCES "public"."exchange_rates"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_journal_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","journal_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_void_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","void_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_runs" ADD CONSTRAINT "recurring_runs_org_id_template_id_recurring_templates_org_id_id_fk" FOREIGN KEY ("org_id","template_id") REFERENCES "public"."recurring_templates"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_templates" ADD CONSTRAINT "recurring_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_org_id_contact_id_contacts_org_id_id_fk" FOREIGN KEY ("org_id","contact_id") REFERENCES "public"."contacts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_org_id_journal_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","journal_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_org_id_reversal_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","reversal_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_costs" ADD CONSTRAINT "item_costs_org_id_item_id_items_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_stock" ADD CONSTRAINT "item_stock_org_id_item_id_items_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_stock" ADD CONSTRAINT "item_stock_org_id_location_id_inventory_locations_org_id_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."inventory_locations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_org_id_item_id_items_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_org_id_location_id_inventory_locations_org_id_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."inventory_locations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_org_id_journal_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","journal_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_org_id_reverses_move_id_stock_moves_org_id_id_fk" FOREIGN KEY ("org_id","reverses_move_id") REFERENCES "public"."stock_moves"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_org_id_from_location_id_inventory_locations_org_id_id_fk" FOREIGN KEY ("org_id","from_location_id") REFERENCES "public"."inventory_locations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_org_id_to_location_id_inventory_locations_org_id_id_fk" FOREIGN KEY ("org_id","to_location_id") REFERENCES "public"."inventory_locations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_org_id_offset_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","offset_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_org_id_journal_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","journal_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_bill_matches" ADD CONSTRAINT "po_bill_matches_org_id_bill_id_documents_org_id_id_fk" FOREIGN KEY ("org_id","bill_id") REFERENCES "public"."documents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_bill_matches" ADD CONSTRAINT "po_bill_matches_org_id_bill_line_id_document_lines_org_id_id_fk" FOREIGN KEY ("org_id","bill_line_id") REFERENCES "public"."document_lines"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_bill_matches" ADD CONSTRAINT "po_bill_matches_org_id_po_line_id_document_lines_org_id_id_fk" FOREIGN KEY ("org_id","po_line_id") REFERENCES "public"."document_lines"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_closures" ADD CONSTRAINT "po_closures_org_id_purchase_order_id_documents_org_id_id_fk" FOREIGN KEY ("org_id","purchase_order_id") REFERENCES "public"."documents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_org_id_receipt_id_purchase_receipts_org_id_id_fk" FOREIGN KEY ("org_id","receipt_id") REFERENCES "public"."purchase_receipts"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_org_id_po_line_id_document_lines_org_id_id_fk" FOREIGN KEY ("org_id","po_line_id") REFERENCES "public"."document_lines"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_org_id_item_id_items_org_id_id_fk" FOREIGN KEY ("org_id","item_id") REFERENCES "public"."items"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_org_id_stock_move_id_stock_moves_org_id_id_fk" FOREIGN KEY ("org_id","stock_move_id") REFERENCES "public"."stock_moves"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_org_id_purchase_order_id_documents_org_id_id_fk" FOREIGN KEY ("org_id","purchase_order_id") REFERENCES "public"."documents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_org_id_location_id_inventory_locations_org_id_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."inventory_locations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_org_id_journal_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","journal_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_org_id_reversal_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","reversal_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_matches" ADD CONSTRAINT "receipt_matches_org_id_attachment_id_attachments_org_id_id_fk" FOREIGN KEY ("org_id","attachment_id") REFERENCES "public"."attachments"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_matches" ADD CONSTRAINT "receipt_matches_org_id_document_id_documents_org_id_id_fk" FOREIGN KEY ("org_id","document_id") REFERENCES "public"."documents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_csv_mappings" ADD CONSTRAINT "bank_csv_mappings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_csv_mappings" ADD CONSTRAINT "bank_csv_mappings_org_id_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_accounts" ADD CONSTRAINT "bank_feed_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_accounts" ADD CONSTRAINT "bank_feed_accounts_org_id_connection_id_integration_connections_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "public"."integration_connections"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_accounts" ADD CONSTRAINT "bank_feed_accounts_org_id_linked_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","linked_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_org_id_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_org_id_mapping_id_bank_csv_mappings_org_id_id_fk" FOREIGN KEY ("org_id","mapping_id") REFERENCES "public"."bank_csv_mappings"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_org_id_connection_id_integration_connections_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "public"."integration_connections"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_rows" ADD CONSTRAINT "bank_import_rows_org_id_batch_id_bank_import_batches_org_id_id_fk" FOREIGN KEY ("org_id","batch_id") REFERENCES "public"."bank_import_batches"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_groups" ADD CONSTRAINT "bank_match_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_groups" ADD CONSTRAINT "bank_match_groups_org_id_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_groups" ADD CONSTRAINT "bank_match_groups_org_id_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_items" ADD CONSTRAINT "bank_match_items_org_id_group_id_bank_match_groups_org_id_id_fk" FOREIGN KEY ("org_id","group_id") REFERENCES "public"."bank_match_groups"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_items" ADD CONSTRAINT "bank_match_items_org_id_bank_transaction_id_bank_transactions_org_id_id_fk" FOREIGN KEY ("org_id","bank_transaction_id") REFERENCES "public"."bank_transactions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_items" ADD CONSTRAINT "bank_match_items_org_id_journal_line_id_journal_lines_org_id_id_fk" FOREIGN KEY ("org_id","journal_line_id") REFERENCES "public"."journal_lines"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rule_applications" ADD CONSTRAINT "bank_rule_applications_org_id_rule_id_bank_rules_org_id_id_fk" FOREIGN KEY ("org_id","rule_id") REFERENCES "public"."bank_rules"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rule_applications" ADD CONSTRAINT "bank_rule_applications_org_id_bank_transaction_id_bank_transactions_org_id_id_fk" FOREIGN KEY ("org_id","bank_transaction_id") REFERENCES "public"."bank_transactions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_org_id_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_org_id_batch_id_bank_import_batches_org_id_id_fk" FOREIGN KEY ("org_id","batch_id") REFERENCES "public"."bank_import_batches"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_org_id_possible_duplicate_of_id_bank_transactions_org_id_id_fk" FOREIGN KEY ("org_id","possible_duplicate_of_id") REFERENCES "public"."bank_transactions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_lines" ADD CONSTRAINT "reconciliation_lines_org_id_reconciliation_id_reconciliations_org_id_id_fk" FOREIGN KEY ("org_id","reconciliation_id") REFERENCES "public"."reconciliations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_lines" ADD CONSTRAINT "reconciliation_lines_org_id_journal_line_id_journal_lines_org_id_id_fk" FOREIGN KEY ("org_id","journal_line_id") REFERENCES "public"."journal_lines"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_org_id_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_org_id_adjustment_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","adjustment_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_org_id_asset_id_fixed_assets_org_id_id_fk" FOREIGN KEY ("org_id","asset_id") REFERENCES "public"."fixed_assets"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_org_id_proceeds_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","proceeds_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_org_id_journal_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","journal_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_org_id_reversal_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","reversal_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_settings" ADD CONSTRAINT "asset_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_tax_books" ADD CONSTRAINT "asset_tax_books_org_id_asset_id_fixed_assets_org_id_id_fk" FOREIGN KEY ("org_id","asset_id") REFERENCES "public"."fixed_assets"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_tax_depreciation" ADD CONSTRAINT "asset_tax_depreciation_org_id_asset_id_fixed_assets_org_id_id_fk" FOREIGN KEY ("org_id","asset_id") REFERENCES "public"."fixed_assets"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_run_lines" ADD CONSTRAINT "depreciation_run_lines_org_id_run_id_depreciation_runs_org_id_id_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "public"."depreciation_runs"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_run_lines" ADD CONSTRAINT "depreciation_run_lines_org_id_asset_id_fixed_assets_org_id_id_fk" FOREIGN KEY ("org_id","asset_id") REFERENCES "public"."fixed_assets"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_org_id_journal_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","journal_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_org_id_reversal_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","reversal_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_org_id_asset_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","asset_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_org_id_accumulated_depreciation_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","accumulated_depreciation_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_org_id_depreciation_expense_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","depreciation_expense_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_org_id_funding_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","funding_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_org_id_source_document_id_documents_org_id_id_fk" FOREIGN KEY ("org_id","source_document_id") REFERENCES "public"."documents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_org_id_source_document_line_id_document_lines_org_id_id_fk" FOREIGN KEY ("org_id","source_document_line_id") REFERENCES "public"."document_lines"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_org_id_acquisition_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","acquisition_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_org_id_class_id_dimension_values_org_id_id_fk" FOREIGN KEY ("org_id","class_id") REFERENCES "public"."dimension_values"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_org_id_department_id_dimension_values_org_id_id_fk" FOREIGN KEY ("org_id","department_id") REFERENCES "public"."dimension_values"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_org_id_location_id_dimension_values_org_id_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."dimension_values"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_org_id_project_id_projects_org_id_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_imports" ADD CONSTRAINT "payroll_imports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_mappings" ADD CONSTRAINT "payroll_mappings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_mappings" ADD CONSTRAINT "payroll_mappings_org_id_expense_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","expense_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_mappings" ADD CONSTRAINT "payroll_mappings_org_id_liability_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","liability_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_org_id_run_id_payroll_runs_org_id_id_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "public"."payroll_runs"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_org_id_contact_id_contacts_org_id_id_fk" FOREIGN KEY ("org_id","contact_id") REFERENCES "public"."contacts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_org_id_department_id_dimension_values_org_id_id_fk" FOREIGN KEY ("org_id","department_id") REFERENCES "public"."dimension_values"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_org_id_class_id_dimension_values_org_id_id_fk" FOREIGN KEY ("org_id","class_id") REFERENCES "public"."dimension_values"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_org_id_location_id_dimension_values_org_id_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."dimension_values"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_org_id_project_id_projects_org_id_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_org_id_journal_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","journal_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_org_id_void_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","void_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_org_id_adjusts_run_id_payroll_runs_org_id_id_fk" FOREIGN KEY ("org_id","adjusts_run_id") REFERENCES "public"."payroll_runs"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_settlements" ADD CONSTRAINT "payroll_settlements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_settlements" ADD CONSTRAINT "payroll_settlements_org_id_run_id_payroll_runs_org_id_id_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "public"."payroll_runs"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_settlements" ADD CONSTRAINT "payroll_settlements_org_id_bank_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","bank_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_settlements" ADD CONSTRAINT "payroll_settlements_org_id_liability_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","liability_account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_settlements" ADD CONSTRAINT "payroll_settlements_org_id_journal_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","journal_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_settlements" ADD CONSTRAINT "payroll_settlements_org_id_void_entry_id_journal_entries_org_id_id_fk" FOREIGN KEY ("org_id","void_entry_id") REFERENCES "public"."journal_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_org_id_budget_id_budgets_org_id_id_fk" FOREIGN KEY ("org_id","budget_id") REFERENCES "public"."budgets"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_org_id_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_org_id_project_id_projects_org_id_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_org_id_dimension_value_id_dimension_values_org_id_id_fk" FOREIGN KEY ("org_id","dimension_value_id") REFERENCES "public"."dimension_values"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elimination_entries" ADD CONSTRAINT "elimination_entries_group_id_entity_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."entity_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elimination_lines" ADD CONSTRAINT "elimination_lines_group_id_entry_id_elimination_entries_group_id_id_fk" FOREIGN KEY ("group_id","entry_id") REFERENCES "public"."elimination_entries"("group_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elimination_lines" ADD CONSTRAINT "elimination_lines_group_id_group_account_id_group_accounts_group_id_id_fk" FOREIGN KEY ("group_id","group_account_id") REFERENCES "public"."group_accounts"("group_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_group_members" ADD CONSTRAINT "entity_group_members_group_id_entity_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."entity_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_group_members" ADD CONSTRAINT "entity_group_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_groups" ADD CONSTRAINT "entity_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_account_mappings" ADD CONSTRAINT "group_account_mappings_group_id_org_id_entity_group_members_group_id_org_id_fk" FOREIGN KEY ("group_id","org_id") REFERENCES "public"."entity_group_members"("group_id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_account_mappings" ADD CONSTRAINT "group_account_mappings_org_id_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_account_mappings" ADD CONSTRAINT "group_account_mappings_group_id_group_account_id_group_accounts_group_id_id_fk" FOREIGN KEY ("group_id","group_account_id") REFERENCES "public"."group_accounts"("group_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_accounts" ADD CONSTRAINT "group_accounts_group_id_entity_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."entity_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_audit_events" ADD CONSTRAINT "group_audit_events_group_id_entity_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."entity_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_rates" ADD CONSTRAINT "group_rates_group_id_entity_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."entity_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_pairs" ADD CONSTRAINT "intercompany_pairs_group_id_entity_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."entity_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_pairs" ADD CONSTRAINT "intercompany_pairs_group_id_org_a_entity_group_members_group_id_org_id_fk" FOREIGN KEY ("group_id","org_a") REFERENCES "public"."entity_group_members"("group_id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_pairs" ADD CONSTRAINT "intercompany_pairs_group_id_org_b_entity_group_members_group_id_org_id_fk" FOREIGN KEY ("group_id","org_b") REFERENCES "public"."entity_group_members"("group_id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_pairs" ADD CONSTRAINT "intercompany_pairs_org_a_account_a_accounts_org_id_id_fk" FOREIGN KEY ("org_a","account_a") REFERENCES "public"."accounts"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_pairs" ADD CONSTRAINT "intercompany_pairs_org_b_account_b_accounts_org_id_id_fk" FOREIGN KEY ("org_b","account_b") REFERENCES "public"."accounts"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_adjustments" ADD CONSTRAINT "tax_adjustments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_custom_categories" ADD CONSTRAINT "tax_custom_categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_exports" ADD CONSTRAINT "tax_exports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_exports" ADD CONSTRAINT "tax_exports_org_id_version_id_tax_mapping_versions_org_id_id_fk" FOREIGN KEY ("org_id","version_id") REFERENCES "public"."tax_mapping_versions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_mapping_sets" ADD CONSTRAINT "tax_mapping_sets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_mapping_versions" ADD CONSTRAINT "tax_mapping_versions_org_id_set_id_tax_mapping_sets_org_id_id_fk" FOREIGN KEY ("org_id","set_id") REFERENCES "public"."tax_mapping_sets"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_mappings" ADD CONSTRAINT "tax_mappings_org_id_version_id_tax_mapping_versions_org_id_id_fk" FOREIGN KEY ("org_id","version_id") REFERENCES "public"."tax_mapping_versions"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_mappings" ADD CONSTRAINT "tax_mappings_org_id_account_id_accounts_org_id_id_fk" FOREIGN KEY ("org_id","account_id") REFERENCES "public"."accounts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_reviews" ADD CONSTRAINT "tax_reviews_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_reviews" ADD CONSTRAINT "tax_reviews_org_id_version_id_tax_mapping_versions_org_id_id_fk" FOREIGN KEY ("org_id","version_id") REFERENCES "public"."tax_mapping_versions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_org_id_document_id_documents_org_id_id_fk" FOREIGN KEY ("org_id","document_id") REFERENCES "public"."documents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_org_id_connection_id_integration_connections_org_id_id_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "public"."integration_connections"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_billing_links" ADD CONSTRAINT "project_billing_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_billing_links" ADD CONSTRAINT "project_billing_links_org_id_invoice_id_documents_org_id_id_fk" FOREIGN KEY ("org_id","invoice_id") REFERENCES "public"."documents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_billing_links" ADD CONSTRAINT "project_billing_links_org_id_project_id_projects_org_id_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_org_id_project_id_projects_org_id_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_org_id_contact_id_contacts_org_id_id_fk" FOREIGN KEY ("org_id","contact_id") REFERENCES "public"."contacts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tokens_org_idx" ON "api_tokens" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "attachments_entity_idx" ON "attachments" USING btree ("org_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_org_created_idx" ON "audit_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_events" USING btree ("org_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "email_events_msg_idx" ON "email_events" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "email_org_idx" ON "email_messages" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "email_entity_idx" ON "email_messages" USING btree ("org_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "integration_org_kind_idx" ON "integration_connections" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "invitations_org_idx" ON "invitations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_uq" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "jobs_org_idx" ON "jobs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_provider_event_uq" ON "webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "webhook_org_idx" ON "webhook_events" USING btree ("org_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_org_system_key_uq" ON "accounts" USING btree ("org_id","system_key") WHERE "accounts"."system_key" is not null;--> statement-breakpoint
CREATE INDEX "contacts_org_name_idx" ON "contacts" USING btree ("org_id","display_name");--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_rates_org_cur_date_src_uq" ON "exchange_rates" USING btree ("org_id","currency","rate_date","source") WHERE "exchange_rates"."source" <> 'transaction';--> statement-breakpoint
CREATE INDEX "exchange_rates_lookup_idx" ON "exchange_rates" USING btree ("org_id","currency","rate_date");--> statement-breakpoint
CREATE INDEX "fiscal_periods_lookup_idx" ON "fiscal_periods" USING btree ("org_id","start_date","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_locations_one_default" ON "inventory_locations" USING btree ("org_id") WHERE "inventory_locations"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "items_org_sku_uq" ON "items" USING btree ("org_id","sku") WHERE "items"."sku" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_org_number_uq" ON "journal_entries" USING btree ("org_id","entry_number") WHERE "journal_entries"."entry_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_org_idem_uq" ON "journal_entries" USING btree ("org_id","idempotency_key") WHERE "journal_entries"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_reverses_uq" ON "journal_entries" USING btree ("org_id","reverses_entry_id") WHERE "journal_entries"."reverses_entry_id" is not null;--> statement-breakpoint
CREATE INDEX "journal_entries_org_date_idx" ON "journal_entries" USING btree ("org_id","entry_date");--> statement-breakpoint
CREATE INDEX "journal_entries_source_idx" ON "journal_entries" USING btree ("org_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "journal_lines_account_idx" ON "journal_lines" USING btree ("org_id","account_id");--> statement-breakpoint
CREATE INDEX "journal_lines_entry_idx" ON "journal_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "journal_lines_open_item_idx" ON "journal_lines" USING btree ("org_id","open_item_id") WHERE "journal_lines"."open_item_id" is not null;--> statement-breakpoint
CREATE INDEX "journal_lines_contact_idx" ON "journal_lines" USING btree ("org_id","contact_id") WHERE "journal_lines"."contact_id" is not null;--> statement-breakpoint
CREATE INDEX "journal_lines_project_idx" ON "journal_lines" USING btree ("org_id","project_id") WHERE "journal_lines"."project_id" is not null;--> statement-breakpoint
CREATE INDEX "cash_basis_lines_account_idx" ON "cash_basis_lines" USING btree ("org_id","account_id","entry_date");--> statement-breakpoint
CREATE INDEX "cash_basis_lines_source_idx" ON "cash_basis_lines" USING btree ("org_id","source_line_id");--> statement-breakpoint
CREATE INDEX "cash_basis_lines_entry_idx" ON "cash_basis_lines" USING btree ("org_id","entry_id");--> statement-breakpoint
CREATE INDEX "document_line_taxes_doc_idx" ON "document_line_taxes" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_lines_doc_idx" ON "document_lines" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_org_kind_number_uq" ON "documents" USING btree ("org_id","kind","number") WHERE "documents"."number" is not null and "documents"."side" = 'sales';--> statement-breakpoint
CREATE INDEX "documents_org_kind_status_idx" ON "documents" USING btree ("org_id","kind","status");--> statement-breakpoint
CREATE INDEX "documents_org_contact_idx" ON "documents" USING btree ("org_id","contact_id");--> statement-breakpoint
CREATE INDEX "documents_org_date_idx" ON "documents" USING btree ("org_id","issue_date");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_ref_uq" ON "payments" USING btree ("org_id","provider","provider_ref") WHERE "payments"."provider_ref" is not null;--> statement-breakpoint
CREATE INDEX "payments_org_contact_idx" ON "payments" USING btree ("org_id","contact_id");--> statement-breakpoint
CREATE INDEX "payments_org_date_idx" ON "payments" USING btree ("org_id","payment_date");--> statement-breakpoint
CREATE INDEX "recurring_due_idx" ON "recurring_templates" USING btree ("status","next_run_date");--> statement-breakpoint
CREATE INDEX "settlements_debit_idx" ON "settlements" USING btree ("org_id","debit_item_id");--> statement-breakpoint
CREATE INDEX "settlements_credit_idx" ON "settlements" USING btree ("org_id","credit_item_id");--> statement-breakpoint
CREATE INDEX "stock_moves_item_idx" ON "stock_moves" USING btree ("org_id","item_id","move_date","seq");--> statement-breakpoint
CREATE INDEX "stock_moves_source_idx" ON "stock_moves" USING btree ("org_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_date_idx" ON "inventory_movements" USING btree ("org_id","movement_date");--> statement-breakpoint
CREATE INDEX "po_bill_matches_po_line_idx" ON "po_bill_matches" USING btree ("org_id","po_line_id");--> statement-breakpoint
CREATE INDEX "po_bill_matches_bill_idx" ON "po_bill_matches" USING btree ("org_id","bill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "po_closures_open_uq" ON "po_closures" USING btree ("org_id","purchase_order_id") WHERE "po_closures"."reopened_at" is null;--> statement-breakpoint
CREATE INDEX "purchase_receipt_lines_po_line_idx" ON "purchase_receipt_lines" USING btree ("org_id","po_line_id");--> statement-breakpoint
CREATE INDEX "purchase_receipts_po_idx" ON "purchase_receipts" USING btree ("org_id","purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_matches_active_uq" ON "receipt_matches" USING btree ("org_id","attachment_id") WHERE "receipt_matches"."unmatched_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_feed_accounts_one_link" ON "bank_feed_accounts" USING btree ("org_id","linked_account_id") WHERE "bank_feed_accounts"."linked_account_id" is not null;--> statement-breakpoint
CREATE INDEX "bank_import_batches_account_idx" ON "bank_import_batches" USING btree ("org_id","account_id","created_at");--> statement-breakpoint
CREATE INDEX "bank_import_rows_batch_idx" ON "bank_import_rows" USING btree ("org_id","batch_id","row_number");--> statement-breakpoint
CREATE INDEX "bank_match_groups_entry_idx" ON "bank_match_groups" USING btree ("org_id","entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_match_items_txn_uq" ON "bank_match_items" USING btree ("org_id","bank_transaction_id") WHERE "bank_match_items"."active" and "bank_match_items"."bank_transaction_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_match_items_line_uq" ON "bank_match_items" USING btree ("org_id","journal_line_id") WHERE "bank_match_items"."active" and "bank_match_items"."journal_line_id" is not null;--> statement-breakpoint
CREATE INDEX "bank_match_items_group_idx" ON "bank_match_items" USING btree ("org_id","group_id");--> statement-breakpoint
CREATE INDEX "bank_rule_applications_rule_idx" ON "bank_rule_applications" USING btree ("org_id","rule_id","created_at");--> statement-breakpoint
CREATE INDEX "bank_rules_priority_idx" ON "bank_rules" USING btree ("org_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transactions_fingerprint_uq" ON "bank_transactions" USING btree ("org_id","account_id","fingerprint") WHERE "bank_transactions"."status" <> 'removed';--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transactions_external_uq" ON "bank_transactions" USING btree ("org_id","account_id","external_id") WHERE "bank_transactions"."external_id" is not null and "bank_transactions"."status" <> 'removed';--> statement-breakpoint
CREATE INDEX "bank_transactions_account_date_idx" ON "bank_transactions" USING btree ("org_id","account_id","posted_date");--> statement-breakpoint
CREATE INDEX "bank_transactions_status_idx" ON "bank_transactions" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_lines_line_uq" ON "reconciliation_lines" USING btree ("org_id","journal_line_id") WHERE "reconciliation_lines"."active";--> statement-breakpoint
CREATE INDEX "reconciliation_lines_rec_idx" ON "reconciliation_lines" USING btree ("org_id","reconciliation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliations_one_in_progress" ON "reconciliations" USING btree ("org_id","account_id") WHERE "reconciliations"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX "reconciliations_account_idx" ON "reconciliations" USING btree ("org_id","account_id","statement_date");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_disposals_one_active" ON "asset_disposals" USING btree ("org_id","asset_id") WHERE "asset_disposals"."status" = 'posted';--> statement-breakpoint
CREATE UNIQUE INDEX "depreciation_once_per_asset_month" ON "depreciation_run_lines" USING btree ("org_id","asset_id","period_end") WHERE "depreciation_run_lines"."status" <> 'reversed';--> statement-breakpoint
CREATE INDEX "depreciation_run_lines_run_idx" ON "depreciation_run_lines" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "depreciation_runs_org_period_idx" ON "depreciation_runs" USING btree ("org_id","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "fixed_assets_source_line_uq" ON "fixed_assets" USING btree ("org_id","source_document_line_id") WHERE "fixed_assets"."source_document_line_id" is not null and "fixed_assets"."status" <> 'draft';--> statement-breakpoint
CREATE INDEX "fixed_assets_org_status_idx" ON "fixed_assets" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "payroll_imports_org_idx" ON "payroll_imports" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "payroll_run_lines_run_idx" ON "payroll_run_lines" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_provider_run_uq" ON "payroll_runs" USING btree ("org_id","provider","provider_run_id") WHERE "payroll_runs"."status" <> 'void';--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_file_uq" ON "payroll_runs" USING btree ("org_id","file_sha256") WHERE "payroll_runs"."status" <> 'void' and "payroll_runs"."file_sha256" is not null;--> statement-breakpoint
CREATE INDEX "payroll_runs_org_date_idx" ON "payroll_runs" USING btree ("org_id","pay_date");--> statement-breakpoint
CREATE INDEX "payroll_settlements_run_idx" ON "payroll_settlements" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "budget_lines_budget_idx" ON "budget_lines" USING btree ("org_id","budget_id");--> statement-breakpoint
CREATE INDEX "elimination_entries_group_idx" ON "elimination_entries" USING btree ("group_id","entry_date");--> statement-breakpoint
CREATE INDEX "group_audit_group_idx" ON "group_audit_events" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE INDEX "tax_adjustments_year_idx" ON "tax_adjustments" USING btree ("org_id","return_type","tax_year_start");--> statement-breakpoint
CREATE INDEX "tax_exports_org_idx" ON "tax_exports" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "tax_mappings_version_idx" ON "tax_mappings" USING btree ("org_id","version_id");--> statement-breakpoint
CREATE INDEX "tax_reviews_year_idx" ON "tax_reviews" USING btree ("org_id","return_type","tax_year_start");--> statement-breakpoint
CREATE INDEX "usage_events_org_metric_idx" ON "usage_events" USING btree ("org_id","metric","created_at");--> statement-breakpoint
CREATE INDEX "payment_links_doc_idx" ON "payment_links" USING btree ("org_id","document_id");--> statement-breakpoint
CREATE INDEX "data_exports_org_idx" ON "data_exports" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_billing_once" ON "project_billing_links" USING btree ("org_id","source_type","source_id") WHERE "project_billing_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "project_billing_invoice_idx" ON "project_billing_links" USING btree ("org_id","invoice_id");--> statement-breakpoint
CREATE INDEX "time_entries_project_idx" ON "time_entries" USING btree ("org_id","project_id","work_date");