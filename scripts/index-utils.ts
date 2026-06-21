import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  COLLECTIONS,
  type CollectionKey,
} from "../src/domain/collections.js";
import {
  type TokenIndex,
  type TokenRecord,
  tokenIndexSchema,
} from "../src/domain/index-schema.js";

const legacyTokenSchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  mint: z.string().min(1).optional(),
});

export async function loadLegacyIndex(
  source: string,
  options: { skipInvalid?: boolean } = {},
): Promise<Record<string, TokenRecord>> {
  const raw = z.record(z.string(), z.unknown()).parse(await readJson(source));
  const normalized: Record<string, TokenRecord> = {};

  for (const [rawId, candidate] of Object.entries(raw)) {
    if (!/^\d+$/.test(rawId)) {
      if (options.skipInvalid) {
        console.warn(
          `Skipping invalid non-numeric token id "${rawId}" in ${source}.`,
        );
        continue;
      }
      throw new Error(`Invalid non-numeric token id "${rawId}" in ${source}.`);
    }

    const id = String(Number(rawId));
    if (normalized[id]) {
      throw new Error(`Duplicate token id "${id}" in ${source}.`);
    }

    const parsedToken = legacyTokenSchema.safeParse(candidate);
    if (!parsedToken.success) {
      if (options.skipInvalid) {
        console.warn(
          `Skipping invalid token ${id} in ${source}: ${z.prettifyError(parsedToken.error)}`,
        );
        continue;
      }
      throw parsedToken.error;
    }

    normalized[id] = parsedToken.data;
  }

  return sortItems(normalized);
}

export function createIndex(
  collections: Record<CollectionKey, Record<string, TokenRecord>>,
): TokenIndex {
  return tokenIndexSchema.parse({
    version: 1,
    generatedAt: new Date().toISOString(),
    collections: {
      gen2: {
        ...COLLECTIONS.gen2,
        items: sortItems(collections.gen2),
      },
      gen3: {
        ...COLLECTIONS.gen3,
        items: sortItems(collections.gen3),
      },
    },
  });
}

export async function writeIndex(
  destination: string,
  index: TokenIndex,
): Promise<void> {
  const absolutePath = path.resolve(destination);
  await mkdir(path.dirname(absolutePath), { recursive: true });

  const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(index, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, absolutePath);
}

function sortItems(
  items: Record<string, TokenRecord>,
): Record<string, TokenRecord> {
  return Object.fromEntries(
    Object.entries(items).sort(([left], [right]) => Number(left) - Number(right)),
  );
}

async function readJson(source: string): Promise<unknown> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, {
      headers: { "user-agent": "MonkeAPI index builder/1.0" },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${source}: HTTP ${response.status}.`);
    }
    return response.json();
  }

  return JSON.parse(await readFile(path.resolve(source), "utf8")) as unknown;
}
