# Stage 9: Implementation Readiness Test (Re-Audit)

**Target Document:** `docs/designs/hitl_approval_layer_design.md`  
**Reviewers:** `egm-implementation-readiness`, `egm-codebase-details`  
**Verdict:** **READY FOR IMPLEMENTATION** (All Blockers & Majors Resolved)

---

## Verified Resolutions

1. **Node.js & NestJS 12 ESM Compatibility:** Updated `engines.node` to `>= 20.19.0` across root `package.json` and `apps/api/test/jest-e2e.json` (`require(esm)` / `--experimental-vm-modules`).
2. **Better Auth + Next.js 16 Rewrites:** Added `WEB_URL` to `.env.example`, `trustedOrigins: [WEB_URL]` and `advanced: { trustedProxyHeaders: true }` in `apps/api/src/auth/auth.ts`, and explicit `/api/v1/:path*` → `${API_INTERNAL_URL}/v1/:path*` rewrite stripping with a `http://localhost:3001` build-time fallback.
3. **Fail-Closed Fallback Approvers:** Added `projects.default_approver_emails` with fallback to organization `owner`/`admin` emails from `members` joined with `users`.
4. **Complete Webhook & Decision Contracts:** Enumerated `WebhookCallbackPayload.event` (`approval.approved | approval.edited_and_approved | approval.rejected | approval.timed_out`) and added optional `approver_name` to `SubmitDecisionRequest`.
5. **Complete Scaffolding File List:** Added `apps/api/src/dashboard/approvals.controller.ts` for `/v1/dashboard/approvals` and `apps/web/postcss.config.mjs` + `src/app/globals.css` for Tailwind v4.
