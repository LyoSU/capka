CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "vault_search_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"node_id" text NOT NULL,
	"fragment_id" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"owner_text" text NOT NULL,
	"model_text" text,
	"norm_title" text GENERATED ALWAYS AS (lower(btrim(regexp_replace(coalesce(title, ''), '[[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+', ' ', 'g')))) STORED NOT NULL,
	"norm_owner_text" text GENERATED ALWAYS AS (lower(btrim(regexp_replace(coalesce(owner_text, ''), '[[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+', ' ', 'g')))) STORED NOT NULL,
	"norm_model_text" text GENERATED ALWAYS AS (lower(btrim(regexp_replace(model_text, '[[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+', ' ', 'g')))) STORED,
	"owner_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || owner_text)) STORED,
	"model_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || coalesce(model_text, ''))) STORED,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ck_vsearch_kind" CHECK ("vault_search_documents"."kind" in ('claim','note','source','fragment'))
);
--> statement-breakpoint
ALTER TABLE "vault_search_documents" ADD CONSTRAINT "vault_search_documents_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_search_documents" ADD CONSTRAINT "vault_search_doc_node_fk" FOREIGN KEY ("space_id","node_id") REFERENCES "public"."vault_nodes"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_vsearch_unit" ON "vault_search_documents" USING btree ("space_id","node_id","fragment_id");--> statement-breakpoint
CREATE INDEX "vault_search_owner_fts" ON "vault_search_documents" USING gin ("owner_tsv");--> statement-breakpoint
CREATE INDEX "vault_search_model_fts" ON "vault_search_documents" USING gin ("model_tsv");--> statement-breakpoint
CREATE INDEX "vault_search_owner_trgm" ON "vault_search_documents" USING gin ("norm_owner_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "vault_search_model_trgm" ON "vault_search_documents" USING gin ("norm_model_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "vault_search_scope" ON "vault_search_documents" USING btree ("space_id","kind");