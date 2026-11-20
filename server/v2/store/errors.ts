export class StoreConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'StoreConflictError'; }
}
export class StoreWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = 'StoreWriteError'; }
}
