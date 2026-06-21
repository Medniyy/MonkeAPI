import { z } from "zod";

import { COLLECTION_KEYS } from "./collections.js";

const tokenSchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  mint: z.string().min(1).optional(),
});

const collectionSchema = z.object({
  name: z.string().min(1),
  mint: z.string().min(1),
  items: z.record(z.string().regex(/^\d+$/), tokenSchema),
});

export const tokenIndexSchema = z.object({
  version: z.literal(1),
  generatedAt: z.iso.datetime(),
  collections: z.object({
    [COLLECTION_KEYS[0]]: collectionSchema,
    [COLLECTION_KEYS[1]]: collectionSchema,
  }),
});

export type TokenIndex = z.infer<typeof tokenIndexSchema>;
export type TokenRecord = z.infer<typeof tokenSchema>;
