export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }

  toJSON() {
    return { status: this.status, code: this.code, message: this.message };
  }
}

export const badRequest = (message: string) => new DomainError(400, 'bad_request', message);
export const forbidden = (message: string) => new DomainError(403, 'forbidden', message);
export const notFound = (message: string) => new DomainError(404, 'not_found', message);
export const conflict = (message: string) => new DomainError(409, 'conflict', message);
export const unavailable = (message: string) => new DomainError(503, 'unavailable', message);
