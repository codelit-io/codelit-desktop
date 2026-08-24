export interface ToolRuntimeExecution<TStep, TContext> {
  runId: string;
  step: TStep;
  context: TContext;
}

/**
 * Runs tool work behind the same workflow lifecycle regardless of where the
 * implementation lives. Browser, hosted, and native runtimes keep machine
 * access out of the shared state machine.
 */
export interface ToolRuntimeAdapter<TStep = unknown, TContext = unknown, TResult = unknown> {
  id: string;
  execute(
    execution: ToolRuntimeExecution<TStep, TContext>,
    signal: AbortSignal,
  ): Promise<TResult | null>;
  cancel?(runId: string): Promise<void>;
}
