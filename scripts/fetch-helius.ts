import { parseArgs } from "node:util";

import { z } from "zod";

import {
  COLLECTIONS,
  type CollectionKey,
} from "../src/domain/collections.js";
import type { TokenRecord } from "../src/domain/index-schema.js";
import { createIndex, writeIndex } from "./index-utils.js";

const assetSchema = z.object({
  id: z.string().min(1),
  content: z.object({
    metadata: z.object({
      name: z.string().min(1),
      attributes: z
        .array(
          z.object({
            trait_type: z.string().optional(),
            value: z.union([z.string(), z.number()]),
          }),
        )
        .optional(),
    }),
    links: z.object({ image: z.string().optional() }).passthrough().optional(),
    files: z
      .array(
        z.object({
          uri: z.string().optional(),
          mime: z.string().optional(),
        }),
      )
      .optional(),
  }),
});

const dasResponseSchema = z.object({
  result: z.object({
    items: z.array(assetSchema),
  }),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
    })
    .optional(),
});

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "./data/index.json" },
    limit: { type: "string", default: "1000" },
  },
  strict: true,
});

const apiKey = process.env.HELIUS_API_KEY;
if (!apiKey) {
  throw new Error("HELIUS_API_KEY is required.");
}

const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
  throw new Error("--limit must be an integer from 1 to 1000.");
}

const rpcUrl =
  process.env.HELIUS_RPC_URL ??
  `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;

const [gen2, gen3] = await Promise.all([
  fetchCollection("gen2", rpcUrl, limit),
  fetchCollection("gen3", rpcUrl, limit),
]);

await writeIndex(values.out!, createIndex({ gen2, gen3 }));
console.log(
  `Wrote ${Object.keys(gen2).length} Gen2 and ${Object.keys(gen3).length} Gen3 tokens to ${values.out}.`,
);

async function fetchCollection(
  collection: CollectionKey,
  endpoint: string,
  pageSize: number,
): Promise<Record<string, TokenRecord>> {
  const items: Record<string, TokenRecord> = {};

  for (let page = 1; ; page += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${collection}-${page}`,
        method: "getAssetsByGroup",
        params: {
          groupKey: "collection",
          groupValue: COLLECTIONS[collection].mint,
          page,
          limit: pageSize,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Helius request for ${collection} page ${page} failed: HTTP ${response.status}.`,
      );
    }

    const payload = dasResponseSchema.parse(await response.json());
    if (payload.error) {
      throw new Error(
        `Helius error ${payload.error.code}: ${payload.error.message}`,
      );
    }

    for (const asset of payload.result.items) {
      const id = extractTokenId(asset.content.metadata);
      const image = selectImage(asset);

      if (!id) {
        throw new Error(
          `Could not extract a token number from "${asset.content.metadata.name}" (${asset.id}).`,
        );
      }
      if (!image) {
        throw new Error(`Asset ${asset.id} has no usable image URL.`);
      }
      if (items[id]) {
        throw new Error(`Duplicate ${collection} token number ${id}.`);
      }

      items[id] = {
        name: asset.content.metadata.name,
        image,
        mint: asset.id,
      };
    }

    console.log(
      `${collection}: page ${page}, ${payload.result.items.length} assets`,
    );

    // DAS "total" is not consistently a grand total. A short page is the
    // reliable pagination terminator.
    if (payload.result.items.length < pageSize) {
      break;
    }
  }

  return items;
}

function extractTokenId(metadata: {
  name: string;
  attributes?:
    | Array<{
        trait_type?: string | undefined;
        value: string | number;
      }>
    | undefined;
}): string | null {
  const numericTrait = metadata.attributes?.find((attribute) => {
    const trait = attribute.trait_type?.trim().toLowerCase();
    return ["number", "token id", "token number", "id"].includes(trait ?? "");
  });
  if (numericTrait && /^\d+$/.test(String(numericTrait.value))) {
    return String(Number(numericTrait.value));
  }

  const hashMatch = metadata.name.match(/#\s*(\d+)/);
  if (hashMatch?.[1]) {
    return String(Number(hashMatch[1]));
  }

  const trailingMatch = metadata.name.match(/(\d+)\s*$/);
  return trailingMatch?.[1] ? String(Number(trailingMatch[1])) : null;
}

function selectImage(asset: z.infer<typeof assetSchema>): string | null {
  if (asset.content.links?.image) {
    return asset.content.links.image;
  }

  const rasterFile = asset.content.files?.find(
    (file) => file.uri && file.mime?.startsWith("image/"),
  );
  return rasterFile?.uri ?? asset.content.files?.find((file) => file.uri)?.uri ?? null;
}
