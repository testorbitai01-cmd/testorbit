export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown, code = 'BAD_REQUEST') => new AppError(400, code, message, details);
export const unauthorized = (message = 'Please sign in to continue', code = 'UNAUTHENTICATED') => new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to perform this action', code = 'FORBIDDEN') =>
  new AppError(403, code, message);
export const notFound = (message = 'Not found', code = 'NOT_FOUND') => new AppError(404, code, message);
export const conflict = (message: string, details?: unknown, code = 'CONFLICT') => new AppError(409, code, message, details);
export const gone = (message: string, code = 'GONE') => new AppError(410, code, message);
export const unprocessable = (message: string, details?: unknown, code = 'UNPROCESSABLE') => new AppError(422, code, message, details);
