import { logError, logEvent } from "./logger.js";
import type { Catalog, CatalogWork } from "./catalog.js";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isRecoverableFailure, normalizePipelineFailure } from "./failures.js";

export type ReelMedia = { path: string; mimeType: string; sizeBytes: number };
export type ReelArtifact = ReelMedia & { kind: "frame" | "audio" };
export type ReelEvidence = { title: string | null; description: string | null; url: string; media?: ReelMedia; artifacts?: ReelArtifact[] };
export type Identification = {
  title: string | null; workType: "movie" | "series" | "unknown"; confidence: number;
  corroborated: boolean; rationale: string; transcriptEvidence?: string | null; onScreenText?: string[];
};

const temporaryDirectoryPrefixes = ["watch-later-", "watch-later-ytdlp-"];
export const DEFAULT_TEMPORARY_MEDIA_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export async function cleanupExpiredTemporaryEvidence(
  root = tmpdir(),
  retentionMs = DEFAULT_TEMPORARY_MEDIA_RETENTION_MS,
  now = Date.now(),
) {
  const entries = await readdir(root, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !temporaryDirectoryPrefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    const path = join(root, entry.name);
    const details = await stat(path).catch(() => null);
    if (details && now - details.mtimeMs >= retentionMs) {
      await rm(path, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

export interface Scraper { scrape(url: string): Promise<ReelEvidence> }
export interface Identifier { identify(evidence: ReelEvidence): Promise<Identification> }
export interface EvidenceExtractor { extract(videoPath: string): Promise<ReelArtifact[]> }
export interface PipelineStore {
  setStatus(id: string, status: "scraping" | "identifying" | "needs_confirmation" | "identified" | "failed", result?: Partial<Identification> & { failureCode?: string }): Promise<void>;
  getUrl(id: string): Promise<string>;
  addToWatchlist(id: string, work: CatalogWork): Promise<void>;
  setCandidates(id: string, candidates: CatalogWork[]): Promise<void>;
  reuseCachedFingerprint(id: string, fingerprint: string): Promise<boolean>;
  setContentFingerprint(id: string, fingerprint: string): Promise<void>;
  setEvidenceSummary?(id: string, summary: Record<string, unknown>): Promise<void>;
  saveEvidenceArtifacts?(id: string, artifacts: Array<ReelArtifact | (ReelMedia & { kind: "video" })>): Promise<void>;
}

export interface WorkResolver {
  resolve(result: Identification): Promise<CatalogWork | null>;
  candidates(result: Identification, limit: number): Promise<CatalogWork[]>;
}

export class CatalogWorkResolver implements WorkResolver {
  constructor(private readonly catalog: Catalog) {}
  async resolve(result: Identification): Promise<CatalogWork | null> {
    if (!result.title || result.workType === "unknown") return null;
    const candidates = await this.catalog.search(result.title, result.workType);
    const normalize = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
    const expected = normalize(result.title);
    return candidates.find((candidate) =>
      normalize(candidate.title) === expected || (candidate.originalTitle ? normalize(candidate.originalTitle) === expected : false)
    ) ?? null;
  }
  async candidates(result: Identification, limit: number) {
    if (!result.title || result.workType === "unknown") return [];
    return (await this.catalog.search(result.title, result.workType)).slice(0, limit);
  }
}

export class PublicInstagramScraper implements Scraper {
  constructor(
    private readonly maxMediaBytes = 100 * 1024 * 1024,
    private readonly maxDurationSeconds = 180,
    private readonly durationProbe: (path: string) => Promise<number> = probeVideoDuration,
    private readonly browserFallback = true,
    private readonly ytDlpFallback = true,
  ) {}

  async scrape(url: string): Promise<ReelEvidence> {
    const primaryHtml = await this.fetchPublicHtml(url, "primary");
    const primary = parseInstagramMetadata(primaryHtml);
    let metadata = primary;
    let layer = "primary";
    let extractedMedia: ReelMedia | undefined;
    if (!primary.mediaUrl) {
      const shortcode = new URL(url).pathname.split("/").filter(Boolean)[1];
      try {
        const embedHtml = await this.fetchPublicHtml(`https://www.instagram.com/reel/${shortcode}/embed/captioned/`, "embed");
        const embed = parseInstagramMetadata(embedHtml);
        metadata = {
          title: primary.title ?? embed.title,
          description: primary.description ?? embed.description,
          mediaUrl: embed.mediaUrl,
          imageUrl: primary.imageUrl ?? embed.imageUrl,
        };
        layer = "embed";
      } catch (error) {
        if (!primary.title && !primary.description) throw error;
      }
    }
    if (!metadata.mediaUrl && this.ytDlpFallback) {
      extractedMedia = await this.downloadWithYtDlp(url);
      if (extractedMedia) layer = "yt-dlp";
    }
    if (!metadata.mediaUrl && !extractedMedia && this.browserFallback) {
      const rendered = await this.renderPublicPage(url);
      metadata = {
        title: metadata.title ?? rendered.title,
        description: metadata.description ?? rendered.description,
        mediaUrl: rendered.mediaUrl,
        imageUrl: metadata.imageUrl ?? rendered.imageUrl,
      };
      if (rendered.title || rendered.description || rendered.mediaUrl || rendered.imageUrl) layer = "browser";
    }
    if (!metadata.title && !metadata.description && !metadata.mediaUrl && !metadata.imageUrl && !extractedMedia) throw new Error("scrape_no_public_evidence");
    logEvent("scraper.evidence_found", { layer, hasMedia: Boolean(metadata.mediaUrl || extractedMedia), hasImage: Boolean(metadata.imageUrl), hasTitle: Boolean(metadata.title), hasDescription: Boolean(metadata.description) });
    const evidence: ReelEvidence = { url, title: metadata.title, description: metadata.description };
    const mediaUrl = metadata.mediaUrl;
    if (extractedMedia) evidence.media = extractedMedia;
    else if (mediaUrl) evidence.media = await this.downloadMedia(mediaUrl);
    else if (metadata.imageUrl) evidence.artifacts = [await this.downloadImage(metadata.imageUrl)];
    return evidence;
  }

  private async downloadWithYtDlp(url: string): Promise<ReelMedia | undefined> {
    const directory = await mkdtemp(join(tmpdir(), "watch-later-ytdlp-"));
    try {
      const metadataResult = await execFileAsync("yt-dlp", [
        "--no-playlist", "--skip-download", "--dump-single-json", "--no-warnings", url,
      ], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
      const metadata = JSON.parse(metadataResult.stdout) as { duration?: number };
      if (typeof metadata.duration === "number" && metadata.duration > this.maxDurationSeconds) throw new Error("media_too_long");
      const outputTemplate = join(directory, "reel.%(ext)s");
      await execFileAsync("yt-dlp", [
        "--no-playlist", "--no-warnings", "--no-progress", "--max-filesize", String(this.maxMediaBytes),
        "--format", "best[ext=mp4]/best", "--output", outputTemplate, url,
      ], { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
      const fileName = (await readdir(directory)).find((name) => name.startsWith("reel."));
      if (!fileName) throw new Error("ytdlp_no_media");
      const path = join(directory, fileName);
      const sizeBytes = (await stat(path)).size;
      if (sizeBytes > this.maxMediaBytes) throw new Error("media_too_large");
      const durationSeconds = await this.durationProbe(path);
      if (durationSeconds > this.maxDurationSeconds) throw new Error("media_too_long");
      return { path, mimeType: fileName.endsWith(".webm") ? "video/webm" : "video/mp4", sizeBytes };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      if (error instanceof Error && ["media_too_long", "media_too_large"].includes(error.message)) throw error;
      logEvent("scraper.ytdlp_unavailable", { reason: error instanceof Error ? error.message : "unknown" });
      return undefined;
    }
  }

  private async renderPublicPage(url: string): Promise<InstagramMetadata> {
    const { chromium } = await import("playwright-core");
    let browser;
    try {
      browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium-browser",
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions"],
      });
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36",
        locale: "en-US", viewport: { width: 412, height: 915 },
      });
      const page = await context.newPage();
      let networkMediaUrl: string | null = null;
      page.on("response", (response) => {
        const contentType = response.headers()["content-type"] ?? "";
        if (!networkMediaUrl && contentType.startsWith("video/")) networkMediaUrl = response.url();
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
      await page.waitForTimeout(3_000);
      const html = await page.content();
      const finalUrl = new URL(page.url());
      if (/\/(?:challenge|checkpoint|accounts\/login)\b/i.test(finalUrl.pathname)) throw new Error("scrape_browser_challenge");
      const metadata = parseInstagramMetadata(html);
      return { ...metadata, mediaUrl: metadata.mediaUrl ?? networkMediaUrl };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("scrape_browser_")) throw error;
      throw new Error("scrape_browser_failed");
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  private async fetchPublicHtml(url: string, layer: string) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36",
          "accept-language": "en-US,en;q=0.8",
          accept: "text/html,application/xhtml+xml",
        },
        redirect: "follow", signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") throw new Error(`scrape_${layer}_timeout`);
      throw new Error(`scrape_${layer}_network_error`);
    }
    if ([404, 410].includes(response.status)) throw new Error("scrape_content_unavailable");
    if ([401, 403].includes(response.status)) throw new Error("scrape_access_restricted");
    if (response.status === 429) throw new Error("scrape_rate_limited");
    if (!response.ok) throw new Error(`scrape_${layer}_http_${response.status}`);
    return response.text();
  }

  private async downloadMedia(rawUrl: string): Promise<ReelMedia> {
    const url = new URL(rawUrl);
    const allowedHost = url.hostname.endsWith(".cdninstagram.com") || url.hostname.endsWith(".fbcdn.net");
    if (url.protocol !== "https:" || !allowedHost) throw new Error("scrape_unsafe_media_url");
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
    const finalUrl = new URL(response.url || url.toString());
    const finalHostAllowed = finalUrl.hostname.endsWith(".cdninstagram.com") || finalUrl.hostname.endsWith(".fbcdn.net");
    if (finalUrl.protocol !== "https:" || !finalHostAllowed) throw new Error("scrape_unsafe_media_redirect");
    if (!response.ok || !response.body) throw new Error(`media_http_${response.status}`);
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > this.maxMediaBytes) throw new Error("media_too_large");
    const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "video/mp4";
    if (!mimeType.startsWith("video/")) throw new Error("media_invalid_type");

    const directory = await mkdtemp(join(tmpdir(), "watch-later-"));
    const path = join(directory, "reel.mp4");
    let sizeBytes = 0;
    const source = Readable.fromWeb(response.body as never);
    source.on("data", (chunk: Buffer) => {
      sizeBytes += chunk.length;
      if (sizeBytes > this.maxMediaBytes) source.destroy(new Error("media_too_large"));
    });
    try {
      await streamPipeline(source, createWriteStream(path, { flags: "wx" }));
      const durationSeconds = await this.durationProbe(path);
      if (!Number.isFinite(durationSeconds)) throw new Error("media_probe_failed");
      if (durationSeconds > this.maxDurationSeconds) throw new Error("media_too_long");
      return { path, mimeType, sizeBytes };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private async downloadImage(rawUrl: string): Promise<ReelArtifact> {
    const url = new URL(rawUrl);
    const allowed = (candidate: URL) => candidate.protocol === "https:" &&
      (candidate.hostname.endsWith(".cdninstagram.com") || candidate.hostname.endsWith(".fbcdn.net"));
    if (!allowed(url)) throw new Error("scrape_unsafe_image_url");
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
    const finalUrl = new URL(response.url || url.toString());
    if (!allowed(finalUrl)) throw new Error("scrape_unsafe_image_redirect");
    if (!response.ok || !response.body) throw new Error(`image_http_${response.status}`);
    const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "";
    if (!mimeType.startsWith("image/")) throw new Error("image_invalid_type");
    const maxImageBytes = 10 * 1024 * 1024;
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > maxImageBytes) throw new Error("image_too_large");
    const directory = await mkdtemp(join(tmpdir(), "watch-later-"));
    const path = join(directory, "reel-cover.jpg");
    let sizeBytes = 0;
    const source = Readable.fromWeb(response.body as never);
    source.on("data", (chunk: Buffer) => {
      sizeBytes += chunk.length;
      if (sizeBytes > maxImageBytes) source.destroy(new Error("image_too_large"));
    });
    try {
      await streamPipeline(source, createWriteStream(path, { flags: "wx" }));
      return { kind: "frame", path, mimeType, sizeBytes };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}

type InstagramMetadata = { title: string | null; description: string | null; mediaUrl: string | null; imageUrl: string | null };
function parseInstagramMetadata(html: string): InstagramMetadata {
  const values = new Map<string, string>();
  for (const tag of html.match(/<meta\s+[^>]*>/gi) ?? []) {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map((match) => [match[1].toLowerCase(), match[2]]));
    const key = attributes.property ?? attributes.name;
    if (key && attributes.content) values.set(key, decodeHtml(attributes.content));
  }
  return {
    title: values.get("og:title") ?? null,
    description: values.get("og:description") ?? values.get("description") ?? null,
    mediaUrl: values.get("og:video:secure_url") ?? values.get("og:video") ?? null,
    imageUrl: values.get("og:image:secure_url") ?? values.get("og:image") ?? null,
  };
}

export class FfmpegEvidenceExtractor implements EvidenceExtractor {
  constructor(private readonly maxFrames = 8) {}

  async extract(videoPath: string): Promise<ReelArtifact[]> {
    const directory = dirname(videoPath);
    const framePattern = join(directory, "frame-%02d.jpg");
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-i", videoPath,
      "-vf", "select=gt(scene\\,0.30),scale=768:-2,format=yuvj420p", "-fps_mode", "vfr",
      "-an", "-frames:v", String(this.maxFrames), framePattern,
    ]).catch(() => undefined);

    let framePaths = (await readdir(directory)).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort();
    if (framePaths.length === 0) {
      await runFfmpeg([
        "-hide_banner", "-loglevel", "error", "-i", videoPath,
        "-vf", "select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,10),scale=768:-2,format=yuvj420p",
        "-fps_mode", "vfr", "-an", "-frames:v", String(this.maxFrames), framePattern,
      ]).catch(() => undefined);
      framePaths = (await readdir(directory)).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort();
    }

    const audioPath = join(directory, "audio.mp3");
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "libmp3lame", "-b:a", "64k", audioPath,
    ]).catch(() => undefined);

    const artifacts: ReelArtifact[] = [];
    for (const name of framePaths.slice(0, this.maxFrames)) {
      const path = join(directory, name);
      artifacts.push({ kind: "frame", path, mimeType: "image/jpeg", sizeBytes: (await stat(path)).size });
    }
    const audioStat = await stat(audioPath).catch(() => null);
    if (audioStat?.size) artifacts.push({ kind: "audio", path: audioPath, mimeType: "audio/mpeg", sizeBytes: audioStat.size });
    return artifacts;
  }
}

async function runFfmpeg(args: string[]) {
  try {
    await execFileAsync("ffmpeg", ["-y", ...args], { timeout: 45_000, maxBuffer: 1024 * 1024 });
  } catch {
    throw new Error("media_extraction_failed");
  }
}

const execFileAsync = promisify(execFile);
async function probeVideoDuration(path: string) {
  try {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path], { timeout: 10_000 });
    return Number(stdout.trim());
  } catch {
    throw new Error("media_probe_failed");
  }
}

const decodeHtml = (value: string) => value
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));

export class IdentificationPipeline {
  constructor(
    private readonly store: PipelineStore,
    private readonly scraper: Scraper,
    private readonly identifier: Identifier,
    private readonly resolver: WorkResolver,
    private readonly evidenceExtractor: EvidenceExtractor = new FfmpegEvidenceExtractor(),
  ) {}
  async run(submissionId: string) {
    const startedAt = Date.now();
    let evidence: ReelEvidence | undefined;
    try {
      logEvent("pipeline.started", { submissionId });
      await this.store.setStatus(submissionId, "scraping");
      evidence = await this.scraper.scrape(await this.store.getUrl(submissionId));
      if (evidence.media) evidence.artifacts = [...(evidence.artifacts ?? []), ...await this.evidenceExtractor.extract(evidence.media.path)];
      await this.store.saveEvidenceArtifacts?.(submissionId, [
        ...(evidence.media ? [{ ...evidence.media, kind: "video" as const }] : []),
        ...(evidence.artifacts ?? []),
      ]);
      await this.store.setEvidenceSummary?.(submissionId, {
        metadata: { title: evidence.title, description: evidence.description },
        media: { present: Boolean(evidence.media), sizeBytes: evidence.media?.sizeBytes ?? 0, mimeType: evidence.media?.mimeType },
        artifacts: (evidence.artifacts ?? []).map(({ kind, mimeType, sizeBytes }) => ({ kind, mimeType, sizeBytes })),
      });
      if (evidence.media) {
        const fingerprint = createHash("sha256").update(await readFile(evidence.media.path)).digest("hex");
        if (await this.store.reuseCachedFingerprint(submissionId, fingerprint)) {
          logEvent("pipeline.cache_fingerprint_hit", { submissionId, fingerprint: fingerprint.slice(0, 12), durationMs: Date.now() - startedAt });
          return;
        }
        await this.store.setContentFingerprint(submissionId, fingerprint);
      }
      logEvent("pipeline.scraped", {
        submissionId,
        hasOgTitle: Boolean(evidence.title),
        hasDescription: Boolean(evidence.description),
        descriptionLength: evidence.description?.length ?? 0,
        hasMedia: Boolean(evidence.media),
        mediaBytes: evidence.media?.sizeBytes ?? 0,
        frameCount: evidence.artifacts?.filter((artifact) => artifact.kind === "frame").length ?? 0,
        hasAudio: evidence.artifacts?.some((artifact) => artifact.kind === "audio") ?? false,
      });
      await this.store.setStatus(submissionId, "identifying");
      const result = await this.identifier.identify(evidence);
      await this.store.setEvidenceSummary?.(submissionId, {
        identification: { rationale: result.rationale, corroborated: result.corroborated, transcriptEvidence: result.transcriptEvidence ?? null, onScreenText: result.onScreenText ?? [] },
      });
      logEvent("pipeline.identified", {
        submissionId,
        workType: result.workType,
        confidence: result.confidence,
        corroborated: result.corroborated,
        hasTitle: Boolean(result.title),
        hasTranscriptEvidence: Boolean(result.transcriptEvidence),
        ocrTextCount: result.onScreenText?.length ?? 0,
      });
      if (!result.title || result.confidence < 0.5) {
        await this.store.setStatus(submissionId, "failed", { failureCode: "low_confidence", ...result });
        logEvent("pipeline.completed", { submissionId, status: "failed", failureCode: "low_confidence", durationMs: Date.now() - startedAt });
        return;
      }
      if (result.confidence < 0.85 || !result.corroborated) {
        const candidates = await this.resolver.candidates(result, 3);
        await this.store.setCandidates(submissionId, candidates);
        await this.store.setStatus(submissionId, "needs_confirmation", result);
        logEvent("pipeline.completed", { submissionId, status: "needs_confirmation", candidateCount: candidates.length, durationMs: Date.now() - startedAt });
        return;
      }
      const work = await this.resolver.resolve(result);
      if (!work) {
        await this.store.setStatus(submissionId, "failed", { failureCode: "catalog_no_match", ...result });
        logEvent("pipeline.completed", { submissionId, status: "failed", failureCode: "catalog_no_match", durationMs: Date.now() - startedAt });
        return;
      }
      await this.store.addToWatchlist(submissionId, work);
      await this.store.setCandidates(submissionId, []);
      logEvent("pipeline.watchlist_added", { submissionId, provider: work.provider, workType: work.type });
      await this.store.setStatus(submissionId, "identified", result);
      logEvent("pipeline.completed", { submissionId, status: "identified", durationMs: Date.now() - startedAt });
    } catch (error) {
      const failureCode = normalizePipelineFailure(error);
      await this.store.setStatus(submissionId, "failed", { failureCode });
      logError("pipeline.failed", error, { submissionId, durationMs: Date.now() - startedAt });
      if (isRecoverableFailure(failureCode)) throw new Error(failureCode);
    } finally {
      // Completed evidence is retained for the configured sweeper window.
      // Partial or invalid downloads are removed at their point of failure.
    }
  }
}
