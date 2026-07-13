import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalIdentifier } from "../src/local-identifier.js";

afterEach(() => vi.restoreAllMocks());

describe("LocalIdentifier", () => {
  it("sends frames to Ollama and validates its structured response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-identifier-test-"));
    const framePath = join(directory, "frame.jpg");
    await writeFile(framePath, new Uint8Array([1, 2, 3]));
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ images?: string[] }> };
      expect(request.messages[0].images).toEqual([Buffer.from([1, 2, 3]).toString("base64")]);
      return new Response(JSON.stringify({
        message: { content: JSON.stringify({
          title: "Fight Club",
          workType: "movie",
          confidence: 0.9,
          corroborated: true,
          rationale: "Metadata and frame agree",
          onScreenText: [],
        }) },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new LocalIdentifier({
      baseUrl: "http://localhost:11434",
      model: "local-test",
      tesseractCommand: "true",
    }).identify({
      url: "https://www.instagram.com/reel/test/",
      title: "Fight Club scene",
      description: null,
      artifacts: [{ kind: "frame", path: framePath, mimeType: "image/jpeg", sizeBytes: 3 }],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ title: "Fight Club", workType: "movie", confidence: 0.9 });
    await rm(directory, { recursive: true, force: true });
  });

  it("returns unknown without invoking Ollama when there is no evidence", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await new LocalIdentifier({ baseUrl: "http://localhost:11434", model: "local-test" })
      .identify({ url: "https://www.instagram.com/reel/test/", title: null, description: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ title: null, workType: "unknown", confidence: 0 });
  });

  it("bounds concurrent OCR timeouts and continues analysis with the frames", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-identifier-timeout-test-"));
    const paths = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
      const path = join(directory, `frame-${index}.jpg`);
      await writeFile(path, new Uint8Array([index]));
      return path;
    }));
    let activeCommands = 0;
    let maxActiveCommands = 0;
    const commandRunner = vi.fn(async () => {
      activeCommands += 1;
      maxActiveCommands = Math.max(maxActiveCommands, activeCommands);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeCommands -= 1;
      throw Object.assign(new Error("Command failed: tesseract ... Detected 63 diacritics"), {
        killed: true,
        signal: "SIGKILL",
      });
    });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      message: { content: JSON.stringify({
        title: null,
        workType: "unknown",
        confidence: 0.1,
        corroborated: false,
        rationale: "Frames are insufficient",
      }) },
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const result = await new LocalIdentifier({
      baseUrl: "http://localhost:11434",
      model: "local-test",
      ocrConcurrency: 2,
      ocrTimeoutMs: 500,
      commandRunner,
    }).identify({
      url: "https://www.instagram.com/reel/test/",
      title: "Scene",
      description: null,
      artifacts: paths.map((path) => ({ kind: "frame", path, mimeType: "image/jpeg", sizeBytes: 1 })),
    });

    expect(commandRunner).toHaveBeenCalledTimes(5);
    expect(maxActiveCommands).toBe(2);
    expect(result).toMatchObject({ workType: "unknown", onScreenText: [] });
    await rm(directory, { recursive: true, force: true });
  });
});
