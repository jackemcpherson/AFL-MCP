/** A reviewed operation cannot proceed with its supplied scope or approval. */
export class OperationConflictError extends Error {
  readonly code = "OPERATION_CONFLICT";

  /**
   * Create an operator-safe conflict with no provider payload or credentials.
   * @param message - Safe explanation written by the application.
   * @example
   * throw new OperationConflictError("Preview is stale; preview again");
   */
  constructor(message: string) {
    super(message);
    this.name = "OperationConflictError";
  }
}
