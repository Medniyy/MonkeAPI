import { UpstreamError } from "../domain/errors.js";
import type { FetchedImage } from "./image-types.js";

const MAX_REDIRECTS = 4;

const SUPPORTED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

export interface UpstreamImageOptions {
  allowedHosts: ReadonlySet<string>;
  timeoutMs: number;
  maxBytes: number;
  fetchImplementation?: typeof fetch;
}

export class UpstreamImageService {
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: UpstreamImageOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  normalizeSource(source: string): URL {
    let normalized = source.trim();

    if (normalized.startsWith("ar://")) {
      normalized = `https://permagate.io/${normalized.slice(5)}`;
    } else if (normalized.startsWith("ipfs://")) {
      normalized = `https://ipfs.io/ipfs/${normalized.slice(7)}`;
    }

    const url = new URL(normalized);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new UpstreamError(
        "UNSUPPORTED_IMAGE_URL",
        "The indexed image uses an unsupported URL scheme.",
      );
    }

    if (url.hostname.toLowerCase() === "arweave.net") {
      url.hostname = "permagate.io";
    }

    this.assertAllowed(url);
    return url;
  }

  async fetch(source: string): Promise<FetchedImage> {
    let url = this.normalizeSource(source);

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await this.fetchWithTimeout(url);

      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new UpstreamError(
            "INVALID_UPSTREAM_REDIRECT",
            "The image host returned a redirect without a destination.",
          );
        }

        url = new URL(location, url);
        this.assertAllowed(url);
        continue;
      }

      if (!response.ok) {
        throw new UpstreamError(
          "UPSTREAM_IMAGE_FAILED",
          `The image host returned HTTP ${response.status}.`,
          { status: response.status, host: url.hostname },
        );
      }

      const body = await readLimitedBody(response, this.options.maxBytes);
      const contentType = resolveContentType(
        response.headers.get("content-type"),
        body,
      );

      if (!contentType) {
        throw new UpstreamError(
          "UNSUPPORTED_IMAGE_TYPE",
          "The image host did not return a supported raster image.",
        );
      }

      return { body, contentType };
    }

    throw new UpstreamError(
      "TOO_MANY_REDIRECTS",
      "The image host redirected too many times.",
    );
  }

  private async fetchWithTimeout(url: URL): Promise<Response> {
    try {
      return await this.fetchImplementation(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(this.options.timeoutMs),
        headers: {
          accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1",
          "user-agent": "MonkeAPI/1.0 (+https://github.com/)",
        },
      });
    } catch (error) {
      throw new UpstreamError(
        "UPSTREAM_IMAGE_UNREACHABLE",
        "The image host could not be reached.",
        error instanceof Error ? { cause: error.message } : undefined,
      );
    }
  }

  private assertAllowed(url: URL): void {
    const hostname = url.hostname.toLowerCase();
    const allowed = [...this.options.allowedHosts].some(
      (allowedHost) =>
        hostname === allowedHost || hostname.endsWith(`.${allowedHost}`),
    );

    if (!allowed) {
      throw new UpstreamError(
        "IMAGE_HOST_NOT_ALLOWED",
        `The indexed image host "${hostname}" is not allowlisted.`,
      );
    }
  }
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new UpstreamError(
      "IMAGE_TOO_LARGE",
      `The upstream image exceeds the ${maxBytes}-byte limit.`,
    );
  }

  if (!response.body) {
    throw new UpstreamError(
      "EMPTY_UPSTREAM_IMAGE",
      "The image host returned an empty response.",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new UpstreamError(
        "IMAGE_TOO_LARGE",
        `The upstream image exceeds the ${maxBytes}-byte limit.`,
      );
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks, totalBytes);
}

function resolveContentType(
  header: string | null,
  body: Buffer,
): string | null {
  const normalizedHeader = header?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalizedHeader && SUPPORTED_CONTENT_TYPES.has(normalizedHeader)) {
    return normalizedHeader;
  }

  if (body.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (body.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) {
    return "image/jpeg";
  }
  if (
    body.subarray(0, 6).toString("ascii") === "GIF87a" ||
    body.subarray(0, 6).toString("ascii") === "GIF89a"
  ) {
    return "image/gif";
  }
  if (
    body.subarray(0, 4).toString("ascii") === "RIFF" &&
    body.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (body.subarray(4, 12).toString("ascii").includes("ftypavif")) {
    return "image/avif";
  }

  return null;
}
