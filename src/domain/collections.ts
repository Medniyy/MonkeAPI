export const COLLECTION_KEYS = ["gen2", "gen3"] as const;

export type CollectionKey = (typeof COLLECTION_KEYS)[number];

export const COLLECTIONS: Record<
  CollectionKey,
  { name: string; mint: string }
> = {
  gen2: {
    name: "Solana Monkey Business Gen2",
    mint: "SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZLHi7W",
  },
  gen3: {
    name: "Solana Monkey Business Gen3",
    mint: "8Rt3Ayqth4DAiPnW9MDFi63TiQJHmohfTWLMQFHi4KZH",
  },
};

export function isCollectionKey(value: string): value is CollectionKey {
  return COLLECTION_KEYS.includes(value as CollectionKey);
}
