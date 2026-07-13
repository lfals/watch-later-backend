import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupExpiredTemporaryEvidence, IdentificationPipeline, PublicInstagramScraper, type PipelineStore } from "../src/pipeline.js";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

afterEach(() => vi.restoreAllMocks());

class MemoryStore implements PipelineStore {
  statuses: string[] = [];
  result: Record<string, unknown> = {};
  async getUrl() { return "https://www.instagram.com/reel/test/"; }
  addedWork: string | null = null;
  candidates: string[] = [];
  async addToWatchlist(_id: string, work: { title: string }) { this.addedWork = work.title; }
  async setCandidates(_id: string, candidates: Array<{ title: string }>) { this.candidates = candidates.map((item) => item.title); }
  async setStatus(_id: string, status: "scraping" | "identifying" | "needs_confirmation" | "identified" | "failed", result = {}) { this.statuses.push(status); this.result = result; }
  fingerprintHit = false;
  async reuseCachedFingerprint() { return this.fingerprintHit; }
  async setContentFingerprint() {}
  savedKinds: string[] = [];
  async saveEvidenceArtifacts(_id: string, artifacts: Array<{ kind: "frame" | "audio" | "video" }>) { this.savedKinds = artifacts.map((item) => item.kind); }
}

describe("IdentificationPipeline", () => {
  it("persists displayable evidence but skips model identification on an exact fingerprint cache hit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "watch-later-cache-test-"));
    const path = join(directory, "reel.mp4");
    await writeFile(path, new Uint8Array([1, 2, 3]));
    const store = new MemoryStore();
    store.fingerprintHit = true;
    const identify = vi.fn();
    const framePath = join(directory, "frame.jpg");
    const audioPath = join(directory, "audio.mp3");
    const extract = vi.fn(async () => {
      await writeFile(framePath, new Uint8Array([4])); await writeFile(audioPath, new Uint8Array([5]));
      return [{ kind: "frame" as const, path: framePath, mimeType: "image/jpeg", sizeBytes: 1 }, { kind: "audio" as const, path: audioPath, mimeType: "audio/mpeg", sizeBytes: 1 }];
    });
    await new IdentificationPipeline(store, { scrape: async (url) => ({ url, title: null, description: null, media: { path, mimeType: "video/mp4", sizeBytes: 3 } }) },
      { identify }, { resolve: async () => null, candidates: async () => [] }, { extract }).run("submission");
    expect(identify).not.toHaveBeenCalled();
    expect(extract).toHaveBeenCalledOnce();
    expect(store.savedKinds).toEqual(["video", "frame", "audio"]);
    await expect(stat(directory)).resolves.toBeDefined();
    await rm(directory, { recursive: true, force: true });
  });
  it("moves a corroboratable result through the stages", async () => {
    const store = new MemoryStore();
    const pipeline = new IdentificationPipeline(store, { scrape: async (url) => ({ url, title: "A scene", description: "Fight Club (1999)" }) }, {
      identify: async () => ({ title: "Fight Club", workType: "movie", confidence: 0.91, corroborated: true, rationale: "Title and year" }),
    }, { resolve: async () => ({ provider: "tmdb", externalId: "550", type: "movie", title: "Fight Club", originalTitle: "Fight Club", releaseYear: "1999", synopsis: null, posterUrl: null }), candidates: async () => [] });
    await pipeline.run("submission");
    expect(store.statuses).toEqual(["scraping", "identifying", "identified"]);
    expect(store.result).toMatchObject({ title: "Fight Club", confidence: 0.91 });
    expect(store.addedWork).toBe("Fight Club");
  });

  it("fails safely when evidence is insufficient", async () => {
    const store = new MemoryStore();
    const pipeline = new IdentificationPipeline(store, { scrape: async (url) => ({ url, title: null, description: null }) }, {
      identify: async () => ({ title: null, workType: "unknown", confidence: 0.1, corroborated: false, rationale: "No evidence" }),
    }, { resolve: async () => null, candidates: async () => [] });
    await pipeline.run("submission");
    expect(store.statuses.at(-1)).toBe("failed");
    expect(store.result).toMatchObject({ failureCode: "low_confidence" });
  });

  it("requires confirmation when confidence is intermediate", async () => {
    const store = new MemoryStore();
    const pipeline = new IdentificationPipeline(store, { scrape: async (url) => ({ url, title: "Scene", description: "Maybe Cowboy Bebop" }) }, {
      identify: async () => ({ title: "Breaking Bad", workType: "series", confidence: 0.72, corroborated: false, rationale: "One metadata hint" }),
    }, { resolve: async () => null, candidates: async () => [{ provider: "tmdb", externalId: "1396", type: "series", title: "Breaking Bad", originalTitle: "Breaking Bad", releaseYear: "2008", synopsis: null, posterUrl: null }] });
    await pipeline.run("submission");
    expect(store.statuses.at(-1)).toBe("needs_confirmation");
    expect(store.candidates).toEqual(["Breaking Bad"]);
  });

  it("passes dedicated frames and audio to identification and retains temporary evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "watch-later-pipeline-test-"));
    const videoPath = join(directory, "reel.mp4");
    const framePath = join(directory, "frame-01.jpg");
    const audioPath = join(directory, "audio.mp3");
    await writeFile(videoPath, new Uint8Array([1]));
    const store = new MemoryStore();
    let receivedKinds: string[] = [];
    const pipeline = new IdentificationPipeline(
      store,
      { scrape: async (url) => ({ url, title: null, description: null, media: { path: videoPath, mimeType: "video/mp4", sizeBytes: 1 } }) },
      { identify: async (evidence) => {
        receivedKinds = evidence.artifacts?.map((artifact) => artifact.kind) ?? [];
        return { title: null, workType: "unknown", confidence: 0.1, corroborated: false, rationale: "No match", transcriptEvidence: "short dialogue", onScreenText: ["studio"] };
      } },
      { resolve: async () => null, candidates: async () => [] },
      { extract: async () => {
        await writeFile(framePath, new Uint8Array([2]));
        await writeFile(audioPath, new Uint8Array([3]));
        return [
          { kind: "frame", path: framePath, mimeType: "image/jpeg", sizeBytes: 1 },
          { kind: "audio", path: audioPath, mimeType: "audio/mpeg", sizeBytes: 1 },
        ];
      } },
    );
    await pipeline.run("submission");
    expect(receivedKinds).toEqual(["frame", "audio"]);
    await expect(stat(directory)).resolves.toBeDefined();
    await rm(directory, { recursive: true, force: true });
  });
});

describe("temporary evidence retention", () => {
  it("removes only application directories older than the retention window", async () => {
    const root = await mkdtemp(join(tmpdir(), "retention-test-"));
    const expired = join(root, "watch-later-expired");
    const fresh = join(root, "watch-later-fresh");
    const unrelated = join(root, "other-expired");
    await Promise.all([mkdir(expired), mkdir(fresh), mkdir(unrelated)]);
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1_000);
    await Promise.all([utimes(expired, eightDaysAgo, eightDaysAgo), utimes(unrelated, eightDaysAgo, eightDaysAgo)]);

    expect(await cleanupExpiredTemporaryEvidence(root, 7 * 24 * 60 * 60 * 1_000, now)).toBe(1);
    await expect(stat(expired)).rejects.toThrow();
    await expect(stat(fresh)).resolves.toBeDefined();
    await expect(stat(unrelated)).resolves.toBeDefined();
    await rm(root, { recursive: true, force: true });
  });
});

describe("PublicInstagramScraper multimodal evidence", () => {
  it("downloads an allowlisted public Reel video with bounded evidence", async () => {
    const html = `<html><meta content="Scene &amp; dialogue" property="og:description"><meta content="https://video.cdninstagram.com/reel.mp4?x=1&amp;y=2" property="og:video:secure_url"></html>`;
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(html, { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "video/mp4", "content-length": "4" } })));
    const evidence = await new PublicInstagramScraper(100, 180, async () => 12).scrape("https://www.instagram.com/reel/test/");
    expect(evidence.description).toBe("Scene & dialogue");
    expect(evidence.media).toMatchObject({ mimeType: "video/mp4", sizeBytes: 4 });
    expect([...await readFile(evidence.media!.path)]).toEqual([1, 2, 3, 4]);
    await rm(dirname(evidence.media!.path), { recursive: true, force: true });
  });

  it("rejects media outside Instagram's public CDN boundary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<meta property="og:video" content="https://example.com/private.mp4">`, { status: 200 })));
    await expect(new PublicInstagramScraper().scrape("https://www.instagram.com/reel/test/")).rejects.toThrow("scrape_unsafe_media_url");
  });

  it("rejects videos longer than three minutes and removes the temporary file", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(`<meta property="og:video" content="https://video.cdninstagram.com/long.mp4">`, { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "video/mp4" } })));
    await expect(new PublicInstagramScraper(100, 180, async () => 181).scrape("https://www.instagram.com/reel/test/")).rejects.toThrow("media_too_long");
  });

  it("falls back to the public captioned embed when the primary page has no video", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(`<meta property="og:description" content="Public caption">`, { status: 200 }))
      .mockResolvedValueOnce(new Response(`<meta content="https://video.cdninstagram.com/embed.mp4" property="og:video">`, { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "video/mp4" } }));
    vi.stubGlobal("fetch", fetchMock);
    const evidence = await new PublicInstagramScraper(100, 180, async () => 5).scrape("https://www.instagram.com/reel/ABC123/");
    expect(evidence.description).toBe("Public caption");
    expect(evidence.media?.sizeBytes).toBe(2);
    expect(fetchMock.mock.calls[1][0]).toBe("https://www.instagram.com/reel/ABC123/embed/captioned/");
    await rm(dirname(evidence.media!.path), { recursive: true, force: true });
  });

  it("uses the public Open Graph image as a visual frame when video is gated", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(`<meta property="og:description" content="Scene"><meta property="og:image" content="https://image.cdninstagram.com/cover.jpg">`, { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([7, 8, 9]), { status: 200, headers: { "content-type": "image/jpeg" } })));
    const evidence = await new PublicInstagramScraper(100, 180, async () => 5, false, false).scrape("https://www.instagram.com/reel/IMAGE123/");
    expect(evidence.media).toBeUndefined();
    expect(evidence.artifacts).toHaveLength(1);
    expect(evidence.artifacts![0]).toMatchObject({ kind: "frame", mimeType: "image/jpeg", sizeBytes: 3 });
    await rm(dirname(evidence.artifacts![0].path), { recursive: true, force: true });
  });

  it.each([[404, "scrape_content_unavailable"], [403, "scrape_access_restricted"], [429, "scrape_rate_limited"]])(
    "maps Instagram HTTP %s to the stable failure code %s",
    async (status, code) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status })));
      await expect(new PublicInstagramScraper().scrape("https://www.instagram.com/reel/test/")).rejects.toThrow(code);
    },
  );
});
