CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_events_external_event_id_unique" UNIQUE("external_event_id")
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "billing_customer_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "billing_subscription_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "billing_status" text DEFAULT 'active' NOT NULL;