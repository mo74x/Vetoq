import type { AgentGate } from '@hitl/sdk';
import type { EditableSchemaMap } from '@hitl/shared';

export interface McpApprovalOptions<TArgs extends Record<string, unknown>> {
  gate: AgentGate;
  actionType: string;
  title: string | ((args: TArgs) => string);
  agentName?: string;
  editableSchema?: EditableSchemaMap;
  timeoutMs?: number;
}

export function wrapToolWithApproval<
  TArgs extends Record<string, unknown>,
  TResult,
>(
  handler: (args: TArgs) => Promise<TResult>,
  options: McpApprovalOptions<TArgs>,
): (args: TArgs) => Promise<TResult | { blocked: true; status: string; requestId: string }> {
  return async (args: TArgs) => {
    const title = typeof options.title === 'function' ? options.title(args) : options.title;
    const decision = await options.gate.requestAndWait<TArgs>({
      actionType: options.actionType,
      title,
      agentName: options.agentName ?? 'mcp-tool',
      payload: args,
      editableSchema: options.editableSchema,
      timeoutMs: options.timeoutMs,
    });

    if (!decision.isApproved) {
      return {
        blocked: true,
        status: decision.status,
        requestId: decision.id,
      };
    }

    return handler(decision.finalPayload);
  };
}
