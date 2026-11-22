CREATE TABLE "circuit_breakers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"max_requests_per_hour" integer,
	"max_cumulative_amount_per_day" integer,
	"amount_field" text,
	"is_tripped" boolean DEFAULT false NOT NULL,
	"tripped_at" timestamp with time zone,
	"tripped_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "circuit_breakers" ADD CONSTRAINT "circuit_breakers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_circuit_breakers_project_action" ON "circuit_breakers" USING btree ("project_id","action_type");