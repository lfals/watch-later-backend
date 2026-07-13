import { createHash } from "node:crypto";

export type NormalizedReel = { originalUrl: string; normalizedUrl: string; normalizedUrlHash: string };

export function normalizeInstagramReel(input: string): NormalizedReel {
  const match = input.match(/https?:\/\/[^\s]+/i);
  if (!match) throw new Error("invalid_reel_url");
  const url = new URL(match[0]);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  if (host !== "instagram.com" || !["reel", "reels"].includes(parts[0] ?? "") || !parts[1]) {
    throw new Error("unsupported_url");
  }
  const normalizedUrl = `https://www.instagram.com/reel/${parts[1]}/`;
  return { originalUrl: match[0], normalizedUrl, normalizedUrlHash: createHash("sha256").update(normalizedUrl).digest("hex") };
}
