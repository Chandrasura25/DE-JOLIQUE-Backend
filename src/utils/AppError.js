/**
 * An error whose message is safe to show to the customer.
 * Anything that is not an AppError is reported as a generic 500.
 */
export default class AppError extends Error {
  constructor(message, statusCode = 400, details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
  }

  static badRequest(message, details) {
    return new AppError(message, 400, details);
  }

  static unauthorized(message = 'Please log in to continue.') {
    return new AppError(message, 401);
  }

  static forbidden(message = 'You do not have permission to do that.') {
    return new AppError(message, 403);
  }

  static notFound(message = 'Not found.') {
    return new AppError(message, 404);
  }

  static conflict(message, details) {
    return new AppError(message, 409, details);
  }

  static unavailable(message) {
    return new AppError(message, 503);
  }
}
