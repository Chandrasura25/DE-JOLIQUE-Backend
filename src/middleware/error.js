import multer from 'multer';
import { isProduction, isTest } from '../config/env.js';
import AppError from '../utils/AppError.js';

export function notFound(req, res, next) {
  next(AppError.notFound(`Route not found: ${req.method} ${req.originalUrl.split('?')[0]}`));
}

const PG_ERRORS = {
  23505: [409, 'That value is already in use.'],
  23503: [400, 'A referenced record does not exist.'],
  23514: [400, 'A value is outside the allowed range.'],
  '22P02': [400, 'Invalid identifier or value.'],
  22001: [400, 'A value is too long.'],
};

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let status = 500;
  let message = 'Something went wrong. Please try again.';
  let details;
  let code;

  if (err instanceof AppError) {
    status = err.statusCode;
    message = err.message;
    details = err.details;
    code = err.code;
  } else if (err instanceof multer.MulterError) {
    status = 400;
    message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Each image must be 4MB or smaller.'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'You can upload up to 6 images at a time.'
          : 'Invalid upload.';
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    message = 'Malformed JSON in request body.';
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    message = 'Request body is too large.';
  } else if (err?.code && PG_ERRORS[err.code]) {
    [status, message] = PG_ERRORS[err.code];
  }

  if (status >= 500 && !isTest) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
  }

  const body = { success: false, message };
  if (code) body.code = code;
  if (details) body.details = details;
  // Stack traces are only ever included for developers running locally.
  if (!isProduction && !isTest && status >= 500) body.debug = err?.message;

  res.status(status).json(body);
}
