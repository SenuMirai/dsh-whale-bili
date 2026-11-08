export class Fault extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}
export function need(condition, code) {
  if (!condition) throw new Fault(code);
}
export function safeError(error) {
  return {
    error: error instanceof Fault ? error.code : "INTERNAL_ERROR",
    message:
      error instanceof Fault
        ? error.message
        : "Operation failed; check local installation and ledger. Raw responses and credentials are withheld.",
    ...(error?.mediaCleanup === "refused_or_failed"
      ? { mediaCleanup: "refused_or_failed" }
      : {}),
  };
}
