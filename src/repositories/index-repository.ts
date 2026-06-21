import { readFile } from "node:fs/promises";

import type { CollectionKey } from "../domain/collections.js";
import {
  type TokenIndex,
  type TokenRecord,
  tokenIndexSchema,
} from "../domain/index-schema.js";
import { NotFoundError } from "../domain/errors.js";

export interface CollectionStats {
  collection: CollectionKey;
  name: string;
  mint: string;
  count: number;
  idRange: { min: number; max: number } | null;
  generatedAt: string;
}

export class IndexRepository {
  private constructor(private readonly index: TokenIndex) {}

  static async fromFile(indexPath: string): Promise<IndexRepository> {
    const raw = await readFile(indexPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return new IndexRepository(tokenIndexSchema.parse(parsed));
  }

  static fromData(index: TokenIndex): IndexRepository {
    return new IndexRepository(tokenIndexSchema.parse(index));
  }

  getToken(collection: CollectionKey, id: string): TokenRecord {
    const token = this.index.collections[collection].items[id];

    if (!token) {
      throw new NotFoundError(
        "TOKEN_NOT_FOUND",
        `No ${collection} token exists with id ${id}.`,
      );
    }

    return token;
  }

  getCollectionStats(collection: CollectionKey): CollectionStats {
    const data = this.index.collections[collection];
    const ids = Object.keys(data.items).map(Number);

    return {
      collection,
      name: data.name,
      mint: data.mint,
      count: ids.length,
      idRange:
        ids.length === 0
          ? null
          : {
              min: Math.min(...ids),
              max: Math.max(...ids),
            },
      generatedAt: this.index.generatedAt,
    };
  }

  get totalTokens(): number {
    return (
      Object.keys(this.index.collections.gen2.items).length +
      Object.keys(this.index.collections.gen3.items).length
    );
  }

  get generatedAt(): string {
    return this.index.generatedAt;
  }
}
