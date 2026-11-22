ALTER TABLE "projects" ADD COLUMN "slack_bot_token_enc" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "slack_signing_secret_enc" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_slack_channel" text;