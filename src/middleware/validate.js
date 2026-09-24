import AppError from '../utils/AppError.js';

/**
 * Validates and coerces req.body / req.query / req.params with zod schemas.
 * Unknown keys are stripped, so only whitelisted fields ever reach a handler.
 */
const validate = (schemas) => (req, res, next) => {
  for (const key of ['params', 'query', 'body']) {
    if (!schemas[key]) continue;
    const result = schemas[key].safeParse(req[key] ?? {});
    if (!result.success) {
      const details = result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
      return next(AppError.badRequest(details[0]?.message || 'Invalid request.', details));
    }
    req[key] = result.data;
  }
  return next();
};

export default validate;
