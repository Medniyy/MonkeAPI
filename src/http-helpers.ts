import type { FastifyReply, FastifyRequest } from "fastify";

import type { AppConfig } from "./config.js";
import { AppError } from "./domain/errors.js";
import type { ImageAsset } from "./services/image-types.js";

export function publicBaseUrl(
  request: FastifyRequest,
  config: AppConfig,
): string {
  return config.baseUrl ?? `${request.protocol}://${request.host}`;
}

export function normalizeTokenId(rawId: string): string {
  if (!/^\d{1,10}$/.test(rawId)) {
    throw new AppError(
      400,
      "INVALID_TOKEN_ID",
      "Token id must contain between 1 and 10 digits.",
    );
  }

  return String(Number(rawId));
}

export function sendImageAsset(
  request: FastifyRequest,
  reply: FastifyReply,
  asset: ImageAsset,
): FastifyReply {
  reply
    .header("access-control-allow-origin", "*")
    .header("cross-origin-resource-policy", "cross-origin")
    .header("timing-allow-origin", "*")
    .header("cache-control", "public, max-age=31536000, immutable")
    .header("content-type", asset.contentType)
    .header("content-length", String(asset.body.byteLength))
    .header("etag", asset.etag)
    .header("x-cache", asset.cacheStatus);

  if (request.headers["if-none-match"] === asset.etag) {
    return reply.code(304).send();
  }

  return reply.send(asset.body);
}
