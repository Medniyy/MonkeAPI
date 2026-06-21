import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import { type AppConfig, loadConfig } from "./config.js";
import {
  COLLECTION_KEYS,
  isCollectionKey,
  type CollectionKey,
} from "./domain/collections.js";
import { AppError, NotFoundError } from "./domain/errors.js";
import {
  normalizeTokenId,
  publicBaseUrl,
  sendImageAsset,
} from "./http-helpers.js";
import { IndexRepository } from "./repositories/index-repository.js";
import { CutoutService } from "./services/cutout-service.js";
import { ImageCache } from "./services/image-cache.js";
import { UpstreamImageService } from "./services/upstream-image-service.js";

interface TokenParams {
  collection: string;
  id: string;
}

interface CollectionParams {
  collection: string;
}

export interface BuildAppOptions {
  config?: AppConfig;
  repository?: IndexRepository;
  fetchImplementation?: typeof fetch;
  logger?: boolean;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const repository =
    options.repository ?? (await IndexRepository.fromFile(config.indexPath));
  const fastifyOptions: FastifyServerOptions = {
    logger: options.logger ?? loggerOptions(config),
    trustProxy: true,
    requestIdHeader: "x-request-id",
    disableRequestLogging: false,
  };
  const app = Fastify(fastifyOptions);

  const rawCache = new ImageCache(config.cacheDir);
  const cutoutCache = new ImageCache(`${config.cacheDir}/cutouts`);
  const upstreamImages = new UpstreamImageService({
    allowedHosts: config.allowedImageHosts,
    timeoutMs: config.upstreamTimeoutMs,
    maxBytes: config.maxImageBytes,
    ...(options.fetchImplementation
      ? { fetchImplementation: options.fetchImplementation }
      : {}),
  });
  const cutouts = new CutoutService(
    {
      directory: config.cutoutDir,
      timeoutMs: config.upstreamTimeoutMs * 4,
      maxBytes: config.maxImageBytes,
      ...(config.cutoutServiceUrl
        ? { serviceUrl: config.cutoutServiceUrl }
        : {}),
      ...(config.cutoutServiceToken
        ? { serviceToken: config.cutoutServiceToken }
        : {}),
      ...(options.fetchImplementation
        ? { fetchImplementation: options.fetchImplementation }
        : {}),
    },
    cutoutCache,
  );

  await app.register(cors, {
    origin: "*",
    methods: ["GET", "HEAD", "OPTIONS"],
    allowedHeaders: ["Accept", "Content-Type", "If-None-Match", "X-Request-Id"],
    exposedHeaders: [
      "Cache-Control",
      "Content-Length",
      "Content-Type",
      "ETag",
      "X-Cache",
      "X-Request-Id",
    ],
    maxAge: 86_400,
  });
  await app.register(helmet, {
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false,
  });
  await app.register(rateLimit, {
    global: false,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindow,
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "MonkeAPI",
        version: "1.0.0",
        description:
          "Canvas-safe metadata and image proxy API for SMB Gen2 and Gen3.",
      },
      tags: [
        { name: "metadata", description: "Collection and token metadata" },
        { name: "images", description: "CORS-safe immutable image assets" },
        { name: "system", description: "Service health" },
      ],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { deepLinking: true },
    staticCSP: true,
  });

  const rateLimitConfig = {
    rateLimit: {
      max: config.rateLimitMax,
      timeWindow: config.rateLimitWindow,
    },
  };

  app.get(
    "/",
    {
      schema: {
        hide: true,
      },
    },
    async (request) => ({
      name: "MonkeAPI",
      version: "1.0.0",
      documentation: `${publicBaseUrl(request, config)}/docs`,
      health: `${publicBaseUrl(request, config)}/healthz`,
      collections: COLLECTION_KEYS,
    }),
  );

  app.get(
    "/healthz",
    {
      schema: {
        tags: ["system"],
        summary: "Liveness check",
      },
    },
    async () => ({
      status: "ok",
      uptimeSeconds: Math.floor(process.uptime()),
    }),
  );

  app.get(
    "/readyz",
    {
      schema: {
        tags: ["system"],
        summary: "Index readiness check",
      },
    },
    async (_request, reply) => {
      const ready = repository.totalTokens > 0;
      return reply.code(ready ? 200 : 503).send({
        status: ready ? "ready" : "not_ready",
        tokens: repository.totalTokens,
        generatedAt: repository.generatedAt,
      });
    },
  );

  app.get<{
    Params: CollectionParams;
  }>(
    "/v1/:collection",
    {
      config: rateLimitConfig,
      schema: {
        tags: ["metadata"],
        summary: "Get collection statistics",
        params: collectionParamsSchema,
      },
    },
    async (request) => {
      const collection = parseCollection(request.params.collection);
      return repository.getCollectionStats(collection);
    },
  );

  app.get<{
    Params: TokenParams;
  }>(
    "/v1/:collection/:id",
    {
      config: rateLimitConfig,
      schema: {
        tags: ["metadata"],
        summary: "Get one token",
        params: tokenParamsSchema,
      },
    },
    async (request) => {
      const collection = parseCollection(request.params.collection);
      const id = normalizeTokenId(request.params.id);
      const token = repository.getToken(collection, id);
      const baseUrl = publicBaseUrl(request, config);
      const hasCutout = await cutouts.isAvailable(collection, id);

      return {
        id: Number(id),
        collection,
        name: token.name,
        image: `${baseUrl}/img/${collection}/${id}.png`,
        cutout: hasCutout
          ? `${baseUrl}/cut/${collection}/${id}.png`
          : null,
      };
    },
  );

  const getRawImage = async (
    collection: CollectionKey,
    id: string,
  ) => {
    const token = repository.getToken(collection, id);
    const normalizedUrl = upstreamImages.normalizeSource(token.image).toString();

    return rawCache.getOrCreate(
      `raw:${collection}:${id}`,
      normalizedUrl,
      () => upstreamImages.fetch(normalizedUrl),
    );
  };

  app.get<{
    Params: TokenParams;
  }>(
    "/img/:collection/:id.png",
    {
      config: rateLimitConfig,
      schema: {
        tags: ["images"],
        summary: "Get a CORS-safe original image",
        params: tokenParamsSchema,
      },
    },
    async (request, reply) => {
      const collection = parseCollection(request.params.collection);
      const id = normalizeTokenId(request.params.id);
      const asset = await getRawImage(collection, id);
      return sendImageAsset(request, reply, asset);
    },
  );

  app.get<{
    Params: TokenParams;
  }>(
    "/cut/:collection/:id.png",
    {
      config: rateLimitConfig,
      schema: {
        tags: ["images"],
        summary: "Get a transparent PNG cutout when available",
        params: tokenParamsSchema,
      },
    },
    async (request, reply) => {
      const collection = parseCollection(request.params.collection);
      const id = normalizeTokenId(request.params.id);
      if (!(await cutouts.isAvailable(collection, id))) {
        throw new NotFoundError(
          "CUTOUT_NOT_AVAILABLE",
          `No transparent cutout is available for ${collection} token ${id}.`,
        );
      }
      const rawImage = await getRawImage(collection, id);
      const asset = await cutouts.get(collection, id, rawImage);
      return sendImageAsset(request, reply, asset);
    },
  );

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send({
      error: {
        code: "ROUTE_NOT_FOUND",
        message: `No route exists for ${request.method} ${request.url}.`,
        requestId: request.id,
      },
    });
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .code(error.statusCode)
        .header("cache-control", "no-store")
        .send({
          error: {
            code: error.code,
            message: error.message,
            requestId: request.id,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        });
    }

    if (error.validation) {
      return reply.code(400).header("cache-control", "no-store").send({
        error: {
          code: "VALIDATION_ERROR",
          message: "The request parameters are invalid.",
          requestId: request.id,
          details: error.validation,
        },
      });
    }

    request.log.error({ err: error }, "Unhandled request error");
    return reply.code(error.statusCode ?? 500).header("cache-control", "no-store").send({
      error: {
        code:
          error.statusCode === 429
            ? "RATE_LIMIT_EXCEEDED"
            : "INTERNAL_SERVER_ERROR",
        message:
          error.statusCode === 429
            ? "Too many requests. Please retry shortly."
            : "An unexpected error occurred.",
        requestId: request.id,
      },
    });
  });

  return app;
}

function loggerOptions(
  config: AppConfig,
): NonNullable<FastifyServerOptions["logger"]> {
  if (config.nodeEnv === "test") {
    return false;
  }

  if (config.nodeEnv === "development") {
    return {
      level: "debug",
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      },
    };
  }

  return { level: "info" };
}

const collectionParamsSchema = {
  type: "object",
  required: ["collection"],
  properties: {
    collection: { type: "string", enum: COLLECTION_KEYS },
  },
  additionalProperties: false,
} as const;

const tokenParamsSchema = {
  type: "object",
  required: ["collection", "id"],
  properties: {
    collection: { type: "string", enum: COLLECTION_KEYS },
    id: { type: "string", pattern: "^\\d{1,10}$" },
  },
  additionalProperties: false,
} as const;

function parseCollection(collection: string): CollectionKey {
  if (!isCollectionKey(collection)) {
    throw new AppError(
      400,
      "INVALID_COLLECTION",
      'Collection must be either "gen2" or "gen3".',
    );
  }

  return collection;
}
