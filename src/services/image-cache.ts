import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FetchedImage, ImageAsset } from "./image-types.js";

interface CacheMetadata {
  sourceKey: string;
  contentType: string;
  etag: string;
  createdAt: string;
}

export class ImageCache {
  private readonly inFlight = new Map<string, Promise<ImageAsset>>();

  constructor(private readonly rootDirectory: string) {}

  async getOrCreate(
    key: string,
    sourceKey: string,
    producer: () => Promise<FetchedImage>,
  ): Promise<ImageAsset> {
    const cacheKey = createHash("sha256").update(key).digest("hex");
    const existing = await this.read(cacheKey, sourceKey);

    if (existing) {
      return existing;
    }

    const running = this.inFlight.get(cacheKey);
    if (running) {
      return running;
    }

    const task = this.create(cacheKey, sourceKey, producer).finally(() => {
      this.inFlight.delete(cacheKey);
    });

    this.inFlight.set(cacheKey, task);
    return task;
  }

  private async read(
    cacheKey: string,
    sourceKey: string,
  ): Promise<ImageAsset | null> {
    try {
      const [body, rawMetadata] = await Promise.all([
        readFile(this.bodyPath(cacheKey)),
        readFile(this.metadataPath(cacheKey), "utf8"),
      ]);
      const metadata = JSON.parse(rawMetadata) as CacheMetadata;

      if (metadata.sourceKey !== sourceKey) {
        return null;
      }

      return {
        body,
        contentType: metadata.contentType,
        etag: metadata.etag,
        cacheStatus: "HIT",
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || error instanceof SyntaxError) {
        return null;
      }

      throw error;
    }
  }

  private async create(
    cacheKey: string,
    sourceKey: string,
    producer: () => Promise<FetchedImage>,
  ): Promise<ImageAsset> {
    const fetched = await producer();
    const etag = makeEtag(fetched.body);
    const metadata: CacheMetadata = {
      sourceKey,
      contentType: fetched.contentType,
      etag,
      createdAt: new Date().toISOString(),
    };

    await mkdir(this.rootDirectory, { recursive: true });

    const suffix = randomUUID();
    const temporaryBody = `${this.bodyPath(cacheKey)}.${suffix}.tmp`;
    const temporaryMetadata = `${this.metadataPath(cacheKey)}.${suffix}.tmp`;

    await Promise.all([
      writeFile(temporaryBody, fetched.body),
      writeFile(temporaryMetadata, `${JSON.stringify(metadata)}\n`, "utf8"),
    ]);
    await Promise.all([
      rename(temporaryBody, this.bodyPath(cacheKey)),
      rename(temporaryMetadata, this.metadataPath(cacheKey)),
    ]);

    return {
      ...fetched,
      etag,
      cacheStatus: "MISS",
    };
  }

  private bodyPath(cacheKey: string): string {
    return path.join(this.rootDirectory, `${cacheKey}.bin`);
  }

  private metadataPath(cacheKey: string): string {
    return path.join(this.rootDirectory, `${cacheKey}.json`);
  }
}

export function makeEtag(body: Buffer): string {
  const digest = createHash("sha256").update(body).digest("base64url");
  return `"sha256-${digest}"`;
}
