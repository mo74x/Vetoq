# Stage 9: Implementation Readiness Test

**Target Document:** `docs/designs/hitl_approval_layer_design.md` (`DetailedRange`: lines 174–256)  
**Reviewers:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`  
**Verdict:** **NOT READY FOR IMPLEMENTATION**

---

## 🔴 Blockers (Must resolve before coding)

1. **Undefined Policy Condition DSL (`packages/shared/src/schemas.ts`, `policy-evaluator.ts`, Lines 187–188)**
   * **Finding:** `policies.conditions` is `JSONB`, and `policy-evaluator.ts` must evaluate conditions and fail closed on parse errors, but the condition schema/DSL (flat rules vs. nested `AND`/`OR` tree, supported operators like `gt`/`gte`/`eq`/`in`/`regex`, dot-path resolution) is never defined.

2. **Undefined `editable_schema` & Edit Submission Contract (`editable-schema.ts`, `schemas.ts`, `editable-form.tsx`, Lines 187–189, 237)**
   * **Finding:** Neither the `editable_schema` JSON format (field types, `editable` flag, `min`/`max`/`maxLength`) nor the `SubmitDecisionRequest` edit payload shape is specified.

3. **Undefined API Request/Response & Webhook Payloads (`schemas.ts`, `approvals.controller.ts`, `review.controller.ts`, Lines 187, 211, 216–218)**
   * **Finding:** Exact request/response schemas and status codes are missing for `POST /v1/approvals` (including `Idempotency-Key` header vs. body, and `auto_approve`/`auto_reject` synchronous vs. webhook behavior), `WebhookCallbackPayload`, and `POST /v1/review/:token/decide`.

4. **Missing Better Auth Setup, NestJS Modules/Guards, & Next.js Client Files (Lines 205–207, 227–229, 239–241)**
   * **Finding:** Item 10 relies on Better Auth session-protected endpoints and Item 13 relies on Better Auth login/org switcher, but no Better Auth server config, NestJS auth guard, Next.js auth client, login route, NestJS `ApiKeyGuard` / `ZodValidationPipe` / `DbModule` / `QueuesModule` are listed. Integrating Better Auth with NestJS 12 requires `bodyParser: false` in `NestFactory.create()`, conflicting with Item 6's raw-body parsing unless `/api/auth/*` is handled explicitly.

5. **Missing OTP Storage Schema (`packages/db/src/schema.ts`, `review.controller.ts`, `review.service.ts`, Lines 93–106, 199, 218)**
   * **Finding:** `POST /v1/review/:token/otp` and 6-digit OTP verification in `decide` have no table/columns in `packages/db/src/schema.ts` (or Redis key scheme) for the hashed OTP, TTL, or failed-attempt lockout limits, and `/otp` vs. `/decide` responsibilities are merged in Line 218.

6. **Undefined `escalate` Timeout Behavior (`packages/db/src/schema.ts`, `timeout.processor.ts`, Lines 96, 124, 223)**
   * **Finding:** `policies.timeout_behavior` allows `'reject' | 'escalate'`, but `timeout.processor.ts` only transitions `pending` requests to `timed_out` with no escalation target columns or escalation flow.

7. **Unauthenticated Billing Webhooks Placed Inside Session-Protected Dashboard Controllers (Lines 93, 227–229)**
   * **Finding:** Item 10 puts "handling Paddle/Polar billing webhooks" inside Better Auth session-protected dashboard controllers (`projects.controller.ts`, etc.), with no chosen provider, no billing schema/subscription columns, and no dedicated raw-body HMAC webhook controller.

---

## 🟡 Majors

1. **Missing Workspace Manifests, TypeScript Configs, & Tooling Files (`package.json`, `tsconfig.json`, `eslint.config.mjs`, `.env.example`, `docker-compose.yml`, Lines 180–182, 249–252):** Verification Plan runs `pnpm --filter @hitl/shared test`, `pnpm --filter @hitl/api test:e2e`, and `pnpm turbo lint`, but per-package manifests/configs, `nest-cli.json`, `next.config.ts`, ESLint/Prettier configs, and container setup are omitted.
2. **Better Auth vs. Custom Tenancy Schema & Drizzle Migration Journal Mismatches (Lines 93, 199, 201–203):** Better Auth defaults to singular table names (`user`, `session`, etc.) unless `usePlural: true` is configured, and its `organization` plugin expects `organization`/`member`/`invitation` rather than `org_memberships`. Also, `0002_audit_immutability_trigger.sql` must be generated via `drizzle-kit generate --custom` so `drizzle/meta/_journal.json` tracks it.
3. **Missing `required_approvals` Column & Stateful `GET` `action_nonce_hash` Contradiction (Lines 98–103, 120, 216):** `approval_requests` omits `required_approvals` referenced on Line 120; `GET /v1/review/:token` claims to be read-only while `approval_tokens` has `action_nonce_hash`.
4. **Cross-Origin Better Auth Session Verification & Auth Mode on `GET /v1/approvals` (Lines 67–68, 211, 229, 240):** Specify shared cookie/BFF proxy/token exchange between Vercel and Railway/Hetzner, plus whether `GET /v1/approvals` accepts API key auth, Better Auth session auth, or both.
5. **Missing `apps/web` Queue/Webhook Inspector Routes & API Client Helper (Lines 67, 235–241):** Item 13 claims to cover the approval queue and webhook retry inspector, but omits their Next.js routes as well as root `app/layout.tsx` and `apps/web/src/lib/` fetch helpers.
6. **Unspecified Email Provider, BullMQ Job IDs, Retry Policy, & HMAC Skew/Raw-Body Details (Lines 125, 207, 218, 224–225, 245):** Pick one email provider (Resend vs. Postmark), define deterministic `timeout:${approvalRequestId}` `jobId`, HTTP timeouts/retry counts, `X-Signature-256` format + `<= 300s` skew + `timingSafeEqual`, and `IF status === 'pending'` before n8n's `Wait` node.
7. **Verification Plan Lacks Container/Migration Setup & `apps/web` / n8n Checks (Lines 247–252):** Specify how test Postgres/Redis containers and migrations run for `test:e2e`, add `test:e2e` to `turbo.json`, and add verification for `apps/web` and `templates/n8n/hitl-approval-workflow.json`.

---

## 🟢 Nits

1. **Package Scope Naming Mismatch (Lines 32–33, 71 vs. 250, 252):** Standardize `@hitl/*` vs. `@agentgate/*`.
2. **Browser/Server Boundary & Dependencies in `packages/shared` (Lines 189–190):** Keep `ssrf.ts` free of `node:dns/promises` so `apps/web` can import `packages/shared`, note `fast-json-patch` / `ipaddr.js`, and pin `engines.node >= 20.9.0`.
3. **Style & Wording Cleanup (Lines 176, 182, 207, 237, 244):** Move the `projects.otp_required` sentence out of the monorepo intro, replace `"Distribution Wedge"` with `"Workflow Template & Quickstart"`, and clarify `"read-only GET review page"`.
