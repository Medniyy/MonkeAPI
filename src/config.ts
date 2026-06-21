import path from "node:path";

import { z } from "zod";

const integerFromEnv = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const optionalUrl = z
  .string()
  .trim()
  .url()
  .optional()
  .transform((value) => value?.replace(/\/+$/, ""));

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  BASE_URL: optionalUrl,
  INDEX_PATH: z.string().min(1).default("./data/index.json"),
  CACHE_DIR: z.string().min(1).optional(),
  CUTOUT_DIR: z.string().min(1).default("./data/cutouts"),
  UPSTREAM_TIMEOUT_MS: integerFromEnv(15_000),
  MAX_IMAGE_BYTES: integerFromEnv(20 * 1024 * 1024),
  RATE_LIMIT_MAX: integerFromEnv(300),
  RATE_LIMIT_WINDOW: z.string().min(1).default("1 minute"),
  ALLOWED_IMAGE_HOSTS: z
    .string()
    .default(
      "permagate.io,gateway.irys.xyz,datasprite-cdn.com,arweave.net,cdn.helius-rpc.com,ipfs.io,nftstorage.link",
    ),
  CUTOUT_SERVICE_URL: optionalUrl,
  CUTOUT_SERVICE_TOKEN: z.string().min(1).optional(),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  baseUrl?: string;
  indexPath: string;
  cacheDir: string;
  cutoutDir: string;
  upstreamTimeoutMs: number;
  maxImageBytes: number;
  rateLimitMax: number;
  rateLimitWindow: string;
  allowedImageHosts: ReadonlySet<string>;
  cutoutServiceUrl?: string;
  cutoutServiceToken?: string;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const env = envSchema.parse(environment);
  const railwayCacheDir = environment.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(environment.RAILWAY_VOLUME_MOUNT_PATH, "cache")
    : undefined;

  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    ...(env.BASE_URL ? { baseUrl: env.BASE_URL } : {}),
    indexPath: path.resolve(env.INDEX_PATH),
    cacheDir: path.resolve(env.CACHE_DIR ?? railwayCacheDir ?? "./.cache"),
    cutoutDir: path.resolve(env.CUTOUT_DIR),
    upstreamTimeoutMs: env.UPSTREAM_TIMEOUT_MS,
    maxImageBytes: env.MAX_IMAGE_BYTES,
    rateLimitMax: env.RATE_LIMIT_MAX,
    rateLimitWindow: env.RATE_LIMIT_WINDOW,
    allowedImageHosts: new Set(
      env.ALLOWED_IMAGE_HOSTS.split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
    ...(env.CUTOUT_SERVICE_URL
      ? { cutoutServiceUrl: env.CUTOUT_SERVICE_URL }
      : {}),
    ...(env.CUTOUT_SERVICE_TOKEN
      ? { cutoutServiceToken: env.CUTOUT_SERVICE_TOKEN }
      : {}),
  };
}
