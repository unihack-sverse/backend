import { z } from 'zod';

export const registerSchema = {
  body: z.object({
    handle: z.string().trim().regex(/^[A-Za-z0-9_]{3,20}$/, 'handle must be 3-20 letters, digits or underscores'),
    email: z.string().trim().email().max(254),
    password: z.string().max(200),
    referralCode: z.string().trim().max(32).optional(),
  }),
};

export const loginSchema = {
  body: z.object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(200),
  }),
};

export const forgotSchema = { body: z.object({ email: z.string().trim().email().max(254) }) };

export const resetSchema = {
  body: z.object({ token: z.string().min(20).max(200), password: z.string().max(200) }),
};

export const verifyEmailSchema = { body: z.object({ token: z.string().min(20).max(200) }) };
