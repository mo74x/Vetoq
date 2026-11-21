# Zero-Install n8n Quickstart

This workflow template works on both **n8n Cloud** and **self-hosted n8n** using native nodes (`HTTP Request`, `IF`, `Wait`, and `Code`).

## Setup

1. Import `templates/n8n/hitl-approval-workflow.json` into n8n.
2. Set the following n8n environment variables:
   * `HITL_API_URL` (e.g., `https://api.yourdomain.com`)
   * `HITL_API_KEY` (`hk_live_...` from your project settings)
   * `HITL_WEBHOOK_SECRET` (`whsec_...` from your project settings)
   * `HITL_WEBHOOK_SECRET_PREV` *(optional, during dual-key rotation)*
3. Connect downstream execution nodes after **Verify HMAC Signature** and read `{{$json.final_payload}}` so human edits are applied.
4. Connect the `false` output of **IF status === pending** to handle synchronous `auto_approved` (`200 OK`) responses without pausing at `Wait`.
