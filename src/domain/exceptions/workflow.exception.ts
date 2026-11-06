export class WorkflowException extends Error {
  constructor(
    readonly code:
      'INSUFFICIENT_CREDITS' | 'WORKFLOW_NOT_FOUND' | 'WORKFLOW_CONFLICT' | 'QUEUE_FULL',
    message: string,
  ) {
    super(message);
  }
}
