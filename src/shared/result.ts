export interface AppError<TCode extends string = string> {
  readonly code: TCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export type Result<TValue, TError extends AppError = AppError> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: TError };

export function ok<TValue>(value: TValue): Result<TValue, never> {
  return { ok: true, value };
}

export function err<TError extends AppError>(error: TError): Result<never, TError> {
  return { ok: false, error };
}
