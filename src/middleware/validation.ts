import { body, param, query, validationResult } from 'express-validator';
import { Request, Response, NextFunction } from 'express';

export const validateRequest = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

export const progressValidation = {
  saveLessonProgress: [
    body('lessonSlug').isString().notEmpty().withMessage('lessonSlug is required'),
    body('courseSlug').isString().notEmpty().withMessage('courseSlug is required'),
    body('secondsWatched').isInt({ min: 0 }).withMessage('secondsWatched must be a positive integer'),
    body('totalDuration').isInt({ min: 0 }).withMessage('totalDuration must be a positive integer'),
    body('percentComplete').isInt({ min: 0, max: 100 }).withMessage('percentComplete must be between 0 and 100'),
    validateRequest
  ],
  getCourseProgress: [
    param('courseSlug').isString().notEmpty().withMessage('courseSlug is required'),
    validateRequest
  ]
};

export const todoValidation = {
  saveTodos: [
    param('lessonSlug').isString().notEmpty().withMessage('lessonSlug is required'),
    body('todos').isObject().withMessage('todos must be an object'),
    validateRequest
  ],
  getTodos: [
    param('lessonSlug').isString().notEmpty().withMessage('lessonSlug is required'),
    validateRequest
  ]
};
