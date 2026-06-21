export interface ImageAsset {
  body: Buffer;
  contentType: string;
  etag: string;
  cacheStatus: "HIT" | "MISS" | "PRECOMPUTED";
}

export interface FetchedImage {
  body: Buffer;
  contentType: string;
}
