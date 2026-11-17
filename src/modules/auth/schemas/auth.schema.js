import { ethers } from 'ethers';
import { z } from 'zod';

export const HANDLE_REGEX = /^[A-Za-z0-9_]{3,20}$/;

const handleField = z.string().trim().regex(HANDLE_REGEX, 'handle must be 3-20 letters, digits or underscores');

const walletAddressField = z
  .string()
  .trim()
  .refine((value) => ethers.isAddress(value), 'must be a valid EVM address')
  .transform((value) => ethers.getAddress(value));

export const registerSchema = {
  body: z.object({
    handle: handleField,
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

export const walletChallengeSchema = {
  body: z.object({
    address: walletAddressField,
    chainId: z.coerce
      .number()
      .int()
      .refine((value) => value === 43113, 'Only Avalanche Fuji Testnet (chainId 43113) is supported.')
      .default(43113),
    purpose: z.enum(['login', 'link']).default('login'),
  }),
};

export const walletVerifySchema = {
  body: z.object({
    address: walletAddressField,
    signature: z.string().trim().min(1).max(500),
    nonce: z.string().trim().min(1).max(128),
    handle: handleField.optional(),
    referralCode: z.string().trim().max(32).optional(),
  }),
};

export const walletLinkSchema = {
  body: z.object({
    address: walletAddressField,
    signature: z.string().trim().min(1).max(500),
    nonce: z.string().trim().min(1).max(128),
  }),
};

export const updateHandleSchema = {
  body: z.object({
    handle: handleField,
  }),
};
