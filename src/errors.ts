// Structured errors shared by every backend. See docs/ARCHITECTURE.md, "Errors".

export type ErrorCode =
  | 'schema'
  | 'type'
  | 'expression'
  | 'plan'
  | 'execution'
  | 'memory'
  | 'handle'
  | 'abort'
  | 'crash';

export class ZamdaError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    // Purpose: base class carrying a stable error code alongside the message
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

export class SchemaError extends ZamdaError {
  constructor(message: string) {
    // Purpose: a table or row does not match the declared schema
    super('schema', message);
  }
}

// Named TypeCheckError, not TypeError, so it never shadows the JS built-in.
export class TypeCheckError extends ZamdaError {
  constructor(message: string) {
    // Purpose: an expression combines types the contract does not allow
    super('type', message);
  }
}

export class ExpressionError extends ZamdaError {
  constructor(message: string) {
    // Purpose: the DSL was misused when building an expression
    super('expression', message);
  }
}

export class PlanError extends ZamdaError {
  constructor(message: string) {
    // Purpose: a plan is invalid, or a backend cannot run it
    super('plan', message);
  }
}

export class ExecutionError extends ZamdaError {
  constructor(message: string) {
    // Purpose: a runtime failure defined by the contract, such as integer overflow
    super('execution', message);
  }
}

export class MemoryError extends ZamdaError {
  constructor(message: string) {
    // Purpose: an operator would exceed the configured memory budget
    super('memory', message);
  }
}

export class HandleError extends ZamdaError {
  constructor(message: string) {
    // Purpose: a table or engine handle is disposed or was lost with its instance
    super('handle', message);
  }
}

export class AbortError extends ZamdaError {
  constructor(message = 'The run was aborted') {
    // Purpose: a run was cancelled through its AbortSignal
    super('abort', message);
  }
}

export class EngineCrashError extends ZamdaError {
  constructor(message: string) {
    // Purpose: the engine module trapped (a bug, or an allocation past the byte limit that could not be refused cleanly); the run produced nothing and the module is replaced
    super('crash', message);
  }
}
