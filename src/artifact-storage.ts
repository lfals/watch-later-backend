import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readFile } from "node:fs/promises";
import type { Config } from "./config.js";

export interface ArtifactStorage {
  put(key: string, path: string, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(keys: string[]): Promise<void>;
}

export class S3ArtifactStorage implements ArtifactStorage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    endpoint: string,
    region: string,
    accessKeyId: string,
    secretAccessKey: string,
    forcePathStyle = false,
  ) {
    this.client = new S3Client({
      endpoint,
      region,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async put(key: string, path: string, mimeType: string) {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: await readFile(path),
      ContentType: mimeType,
    }));
  }

  async get(key: string) {
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!object.Body) throw new Error("artifact_object_empty");
    return Buffer.from(await object.Body.transformToByteArray());
  }

  async delete(keys: string[]) {
    for (let index = 0; index < keys.length; index += 1_000) {
      const batch = keys.slice(index, index + 1_000);
      if (batch.length) await this.client.send(new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }));
    }
  }
}

export function artifactStorageFromConfig(config: Config): ArtifactStorage | undefined {
  const values = [config.S3_BUCKET, config.S3_ENDPOINT, config.S3_ACCESS_KEY_ID, config.S3_SECRET_ACCESS_KEY];
  if (values.every(Boolean)) return new S3ArtifactStorage(
    config.S3_BUCKET!, config.S3_ENDPOINT!, config.S3_REGION ?? "auto", config.S3_ACCESS_KEY_ID!, config.S3_SECRET_ACCESS_KEY!,
    config.S3_FORCE_PATH_STYLE === "true",
  );
  if (values.some(Boolean)) throw new Error("S3 configuration is incomplete");
  return undefined;
}
