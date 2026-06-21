import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CollectionKey } from "../domain/collections.js";
import { AppError, NotFoundError, UpstreamError } from "../domain/errors.js";
import type { ImageAsset } from "./image-types.js";
import { ImageCache, makeEtag } from "./image-cache.js";

export interface CutoutServiceOptions {
  directory: string;
  serviceUrl?: string;
  serviceToken?: string;
  timeoutMs: number;
  maxBytes: number;
  fetchImplementation?: typeof fetch;
}

export class CutoutService {
  private readonly fetchImplementation: typeof fetch;

  constructor(
    private readonly options: CutoutServiceOptions,
    private readonly cache: ImageCache,
  ) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async isAvailable(collection: CollectionKey, id: string): Promise<boolean> {
    if (await this.hasPrecomputed(collection, id)) {
      return true;
    }

    return Boolean(this.options.serviceUrl);
  }

  async get(
    collection: CollectionKey,
    id: string,
    rawImage: ImageAsset,
  ): Promise<ImageAsset> {
    const precomputed = await this.readPrecomputed(collection, id);
    if (precomputed) {
      return precomputed;
    }

    if (!this.options.serviceUrl) {
      throw new NotFoundError(
        "CUTOUT_NOT_AVAILABLE",
        `No transparent cutout is available for ${collection} token ${id}.`,
      );
    }

    const sourceKey = `${rawImage.etag}:${this.options.serviceUrl}`;
    return this.cache.getOrCreate(
      `cutout:${collection}:${id}`,
      sourceKey,
      async () => {
        const headers = new Headers({
          accept: "image/png",
          "content-type": rawImage.contentType,
          "x-monke-collection": collection,
          "x-monke-id": id,
        });
        if (this.options.serviceToken) {
          headers.set(
            "authorization",
            `Bearer ${this.options.serviceToken}`,
          );
        }

        let response: Response;
        try {
          response = await this.fetchImplementation(this.options.serviceUrl!, {
            method: "POST",
            headers,
            body: new Uint8Array(rawImage.body),
            signal: AbortSignal.timeout(this.options.timeoutMs),
          });
        } catch (error) {
          throw new UpstreamError(
            "CUTOUT_SERVICE_UNREACHABLE",
            "The background-removal service could not be reached.",
            error instanceof Error ? { cause: error.message } : undefined,
          );
        }

        if (!response.ok) {
          throw new UpstreamError(
            "CUTOUT_SERVICE_FAILED",
            `The background-removal service returned HTTP ${response.status}.`,
          );
        }

        const body = Buffer.from(await response.arrayBuffer());
        if (body.byteLength === 0 || body.byteLength > this.options.maxBytes) {
          throw new AppError(
            502,
            "INVALID_CUTOUT_RESPONSE",
            "The background-removal service returned an invalid image size.",
          );
        }
        if (!body.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
          throw new AppError(
            502,
            "INVALID_CUTOUT_RESPONSE",
            "The background-removal service did not return a PNG.",
          );
        }

        return { body, contentType: "image/png" };
      },
    );
  }

  private async hasPrecomputed(
    collection: CollectionKey,
    id: string,
  ): Promise<boolean> {
    try {
      await readFile(this.precomputedPath(collection, id));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async readPrecomputed(
    collection: CollectionKey,
    id: string,
  ): Promise<ImageAsset | null> {
    try {
      const body = await readFile(this.precomputedPath(collection, id));
      return {
        body,
        contentType: "image/png",
        etag: makeEtag(body),
        cacheStatus: "PRECOMPUTED",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private precomputedPath(collection: CollectionKey, id: string): string {
    return path.join(this.options.directory, collection, `${id}.png`);
  }
}
