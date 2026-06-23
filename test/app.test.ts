import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { TokenIndex } from "../src/domain/index-schema.js";
import { IndexRepository } from "../src/repositories/index-repository.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex",
);

describe("MonkeAPI", () => {
  let app: FastifyInstance;
  let temporaryDirectory: string;
  let fetchCalls: URL[];

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "monke-api-"));
    fetchCalls = [];

    app = await buildApp({
      config: testConfig(temporaryDirectory),
      repository: IndexRepository.fromData(testIndex),
      fetchImplementation: async (input) => {
        const url =
          input instanceof URL
            ? input
            : new URL(typeof input === "string" ? input : input.url);
        fetchCalls.push(url);
        return new Response(new Uint8Array(PNG), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      },
      logger: false,
    });
  });

  afterEach(async () => {
    await app.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("returns one sparse token without assuming contiguous ids", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/gen3/12677",
      headers: { host: "api.monke.test" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: 12677,
      collection: "gen3",
      name: "SMB Gen3 #12677",
      image: "http://api.monke.test/img/gen3/12677.png",
      cutout: null,
    });
  });

  it("returns collection counts and the real sparse id range", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/gen3",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      collection: "gen3",
      count: 2,
      idRange: { min: 9, max: 12677 },
    });
  });

  it("404s cleanly for an unknown id", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/gen3/10",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("TOKEN_NOT_FOUND");
  });

  it("proxies gen2 Arweave art through the Magic Eden image CDN with canvas-safe headers", async () => {
    const first = await app.inject({
      method: "GET",
      url: "/img/gen2/1.png",
    });
    const second = await app.inject({
      method: "GET",
      url: "/img/gen2/1.png",
    });

    expect(first.statusCode).toBe(200);
    expect(first.headers["access-control-allow-origin"]).toBe("*");
    expect(first.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(first.headers["cache-control"]).toContain("immutable");
    expect(first.headers["content-type"]).toBe("image/png");
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(second.headers["x-cache"]).toBe("HIT");
    // Only the first request hits upstream; the second is served from cache.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.hostname).toBe("img-cdn.magiceden.dev");
    // The raw Arweave tx is wrapped (URL-encoded) inside the CDN path, PNG-forced.
    const cdnPath = fetchCalls[0]?.pathname ?? "";
    expect(decodeURIComponent(cdnPath)).toContain(
      "https://arweave.net/example-transaction",
    );
    expect(cdnPath.endsWith("@png")).toBe(true);
  });

  it("supports conditional image requests", async () => {
    const first = await app.inject({
      method: "GET",
      url: "/img/gen3/12677.png",
    });
    const second = await app.inject({
      method: "GET",
      url: "/img/gen3/12677.png",
      headers: { "if-none-match": first.headers.etag },
    });

    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
  });

  it("does not fetch raw art when no cutout capability exists", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/cut/gen3/12677.png",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("CUTOUT_NOT_AVAILABLE");
    expect(fetchCalls).toHaveLength(0);
  });
});

const testIndex: TokenIndex = {
  version: 1,
  generatedAt: "2026-06-22T00:00:00.000Z",
  collections: {
    gen2: {
      name: "Solana Monkey Business Gen2",
      mint: "SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZLHi7W",
      items: {
        "1": {
          name: "SMB #1",
          image: "https://arweave.net/example-transaction",
        },
      },
    },
    gen3: {
      name: "Solana Monkey Business Gen3",
      mint: "8Rt3Ayqth4DAiPnW9MDFi63TiQJHmohfTWLMQFHi4KZH",
      items: {
        "9": {
          name: "SMB Gen3 #9",
          image: "https://gateway.irys.xyz/example-9",
        },
        "12677": {
          name: "SMB Gen3 #12677",
          image: "https://gateway.irys.xyz/example-12677",
        },
      },
    },
  },
};

function testConfig(directory: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3000,
    indexPath: path.join(directory, "index.json"),
    cacheDir: path.join(directory, "cache"),
    cutoutDir: path.join(directory, "cutouts"),
    upstreamTimeoutMs: 1_000,
    maxImageBytes: 1024 * 1024,
    rateLimitMax: 1_000,
    rateLimitWindow: "1 minute",
    allowedImageHosts: new Set([
      "img-cdn.magiceden.dev",
      "arweave.net",
      "permagate.io",
      "gateway.irys.xyz",
    ]),
  };
}
