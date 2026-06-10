import { z } from 'zod';

export const variantDimensionSchema = z.object({
  name: z.string().trim().min(1, 'Variant name is required').max(20),
  options: z
    .array(z.string().trim().min(1).max(20))
    .min(1, 'At least one option required')
    .max(5, 'Max 5 options per variant'),
});

export const createDropSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(100),
  description: z.string().trim().max(280, 'Description must be 280 characters or less').optional(),
  price_cents: z
    .number()
    .int()
    .min(100, 'Minimum price is $1.00')
    .max(99999900, 'Price too high'),
  inventory: z.number().int().min(1, 'Inventory must be at least 1').max(100000),
  weight_oz: z.number().min(0.1, 'Weight is required for shipping').max(1120),
  dimensions: z.object({
    length_in: z.number().min(0.1).max(108),
    width_in: z.number().min(0.1).max(108),
    height_in: z.number().min(0.1).max(108),
  }),
  variants: z.array(variantDimensionSchema).max(2, 'Max 2 variant dimensions').optional(),
});

export type CreateDropInput = z.infer<typeof createDropSchema>;

export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI',
  'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN',
  'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY',
] as const;

// US-only from-address, stored on profiles.from_address.
export const fromAddressSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(60),
  street1: z.string().trim().min(1, 'Street address is required').max(100),
  street2: z.string().trim().max(100).optional(),
  city: z.string().trim().min(1, 'City is required').max(60),
  state: z.enum(US_STATES, { errorMap: () => ({ message: 'Select a US state' }) }),
  zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'Enter a valid US ZIP code'),
  country: z.literal('US').default('US'),
});

export type FromAddress = z.infer<typeof fromAddressSchema>;

export const createDiscountSchema = z.object({
  code: z
    .string()
    .trim()
    .min(3, 'Code must be at least 3 characters')
    .max(20, 'Code must be at most 20 characters')
    .regex(/^[A-Za-z0-9]+$/, 'Letters and numbers only'),
  percent_off: z.number().int().min(1).max(100),
});

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'drop';
}
