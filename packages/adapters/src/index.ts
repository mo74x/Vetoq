import type { AgentGate } from '@hitl/sdk';
import type { EditableSchemaMap } from '@hitl/shared';

export interface AdapterApprovalConfig<TArgs extends Record<string, unknown>> {
  gate: AgentGate;
  actionType: string;
  title: string | ((args: TArgs) => string);
  editableSchema?: EditableSchemaMap;
  timeoutMs?: number;
}

/**
 * Wraps a Vercel AI SDK tool definition (`{ description, parameters, execute }`)
 * so tool execution pauses for HITL approval and uses `decision.finalPayload`.
 */
export function withVetoqVercelTool<
  TArgs extends Record<string, unknown>,
  TResult,
  TTool extends { execute: (args: TArgs) => Promise<TResult> },
>(toolDef: TTool, config: AdapterApprovalConfig<TArgs>): TTool {
  return {
    ...toolDef,
    execute: async (args: TArgs) => {
      const title = typeof config.title === 'function' ? config.title(args) : config.title;
      const decision = await config.gate.requestAndWait<TArgs>({
        actionType: config.actionType,
        title,
        agentName: 'vercel-ai-sdk',
        payload: args,
        editableSchema: config.editableSchema,
        timeoutMs: config.timeoutMs,
      });

      if (!decision.isApproved) {
        return {
          blocked: true,
          status: decision.status,
          requestId: decision.id,
        } as unknown as TResult;
      }

      return toolDef.execute(decision.finalPayload);
    },
  };
}

/**
 * Creates a LangGraph node function that requests HITL approval on graph state
 * and returns `{ vetoqDecision, approvedPayload }`.
 */
export function createLangGraphApprovalNode<TState extends Record<string, unknown>>(
  config: Omit<AdapterApprovalConfig<Record<string, unknown>>, 'title'> & {
    title: string | ((state: TState) => string);
    getPayload: (state: TState) => Record<string, unknown>;
  },
) {
  return async (state: TState) => {
    const payload = config.getPayload(state);
    const title = typeof config.title === 'function' ? config.title(state) : config.title;
    const decision = await config.gate.requestAndWait({
      actionType: config.actionType,
      title,
      agentName: 'langgraph-node',
      payload,
      editableSchema: config.editableSchema,
      timeoutMs: config.timeoutMs,
    });

    return {
      vetoqDecision: decision,
      approvedPayload: decision.finalPayload,
    };
  };
}
