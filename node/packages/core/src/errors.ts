export interface ErrorContext {
  operation?: string | undefined;
  target?: string | undefined;
  provider?: string | undefined;
  retry_after?: number | undefined;
  item_ids?: readonly string[];
}

export class StorageError extends Error {
  readonly operation: string | undefined;
  readonly target: string | undefined;
  readonly provider: string | undefined;
  readonly retry_after: number | undefined;
  readonly item_ids: readonly string[];

  constructor(message: string, context: ErrorContext = {}) {
    super(message);
    this.name = new.target.name;
    this.operation = context.operation;
    this.target = context.target;
    this.provider = context.provider;
    this.retry_after = context.retry_after;
    this.item_ids = context.item_ids ?? [];
  }
}

export class NotFoundError extends StorageError {}
export class AlreadyExistsError extends StorageError {}
export class AmbiguousPathError extends StorageError {}
export class InvalidPathError extends StorageError {}
export class InvalidArgumentError extends StorageError {}
export class InvalidUploadSourceError extends StorageError {}
export class NotDirectoryError extends StorageError {}
export class IsDirectoryError extends StorageError {}
export class DirectoryNotEmptyError extends StorageError {}
export class AuthenticationError extends StorageError {}
export class PermissionDeniedError extends StorageError {}
export class RateLimitError extends StorageError {}
export class QuotaExceededError extends StorageError {}
export class ConflictError extends StorageError {}
export class IndeterminateOperationError extends StorageError {}
export class UnsupportedOperationError extends StorageError {}
export class ProviderUnavailableError extends StorageError {}
export class ProviderError extends StorageError {}
