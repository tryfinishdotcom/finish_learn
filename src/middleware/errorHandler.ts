import { Request, Response, NextFunction } from 'express';
import * as Sentry from '@sentry/node';

type HttpError = Error & {
  status?: number;
  statusCode?: number;
  expose?: boolean;
  type?: string;
};

// The status the error carries (http-errors / body-parser set `status`), else 500.
function statusOf(err: HttpError): number {
  const status = err.status ?? err.statusCode;
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : 500;
}

// The browser hung up before the body arrived (e.g. the learner navigated away while
// lesson progress was saving). Nothing went wrong on our side.
function isClientAbort(err: HttpError, req: Request): boolean {
  return err.type === 'request.aborted' || req.aborted === true;
}

export function errorHandler(
  err: HttpError,
  req: Request,
  res: Response,
  next: NextFunction
) {
  const status = statusOf(err);

  // Only server faults are errors worth reporting; 4xx and client aborts are not.
  if (status >= 500 && !isClientAbort(err, req)) {
    Sentry.captureException(err);
  }

  // Log to console in development
  if (process.env.NODE_ENV === 'development') {
    console.error('Error:', err);
  }

  if (res.headersSent) {
    return next(err);
  }

  const clientError = status < 500;

  // Send error response
  res.status(status).json({
    error: clientError ? (err.expose ? err.message : 'Bad request') : 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
}
