export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = "api_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message: string, code = "bad_request"): ApiError {
  return new ApiError(400, message, code);
}

export function unauthorized(message = "Authentication required."): ApiError {
  return new ApiError(401, message, "unauthorized");
}

export function forbidden(message = "Admin credentials required."): ApiError {
  return new ApiError(403, message, "forbidden");
}

export function notFound(message = "Not found."): ApiError {
  return new ApiError(404, message, "not_found");
}
