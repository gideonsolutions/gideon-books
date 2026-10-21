/**
 * Where attachment bytes live. Two drivers, chosen by STORAGE_DRIVER:
 *  fs (default) — a directory (STORAGE_DIR, default ./storage); back it up with the database.
 *  s3 — any S3-compatible store (AWS S3, MinIO, R2, B2) via S3_ENDPOINT, S3_REGION,
 *       S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.
 * Keys always begin with the organization's id, so one organization's files
 * are never addressed through another's records.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";

export interface Storage {
  name: string;
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

function safeKey(key: string): string {
  if (!/^[a-zA-Z0-9/_.-]+$/.test(key) || key.includes("..") || key.startsWith("/")) throw new Error(`invalid storage key ${key}`);
  return key;
}

export class FsStorage implements Storage {
  name = "fs";
  constructor(private root: string) {}
  private p(key: string) {
    return path.join(this.root, safeKey(key));
  }
  async put(key: string, bytes: Buffer) {
    const file = this.p(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, bytes, { mode: 0o600 });
    await fs.rename(tmp, file);
  }
  async get(key: string) {
    return fs.readFile(this.p(key));
  }
  async delete(key: string) {
    await fs.rm(this.p(key), { force: true });
  }
  async exists(key: string) {
    try {
      await fs.access(this.p(key));
      return true;
    } catch {
      return false;
    }
  }
}

/** A minimal S3 client (AWS Signature Version 4, path-style URLs). */
export class S3Storage implements Storage {
  name = "s3";
  constructor(private cfg: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }) {}

  private async request(method: "PUT" | "GET" | "DELETE" | "HEAD", key: string, body?: Buffer, contentType?: string): Promise<Response> {
    const url = new URL(`${this.cfg.endpoint.replace(/\/$/, "")}/${this.cfg.bucket}/${safeKey(key)}`);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = amzDate.slice(0, 8);
    const payloadHash = createHash("sha256").update(body ?? Buffer.alloc(0)).digest("hex");
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      ...(contentType ? { "content-type": contentType } : {}),
    };
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonical = [
      method,
      url.pathname.split("/").map(encodeURIComponent).join("/"),
      "",
      Object.keys(headers)
        .sort()
        .map((h) => `${h}:${headers[h]}\n`)
        .join(""),
      signedHeaders,
      payloadHash,
    ].join("\n");
    const scope = `${day}/${this.cfg.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
    const hmac = (k: Buffer | string, v: string) => createHmac("sha256", k).update(v).digest();
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.cfg.secretAccessKey}`, day), this.cfg.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    delete headers.host;
    return fetch(url, { method, headers, ...(body ? { body: new Uint8Array(body) } : {}), signal: AbortSignal.timeout(60_000) });
  }

  async put(key: string, bytes: Buffer, contentType: string) {
    const r = await this.request("PUT", key, bytes, contentType);
    if (!r.ok) throw new Error(`storage put failed: ${r.status} ${await r.text()}`);
  }
  async get(key: string) {
    const r = await this.request("GET", key);
    if (!r.ok) throw new Error(`storage get failed: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  async delete(key: string) {
    const r = await this.request("DELETE", key);
    if (!r.ok && r.status !== 404) throw new Error(`storage delete failed: ${r.status}`);
  }
  async exists(key: string) {
    const r = await this.request("HEAD", key);
    return r.ok;
  }
}

let cached: Storage | null = null;

export function storage(): Storage {
  if (cached) return cached;
  const driver = (process.env.STORAGE_DRIVER ?? "fs").toLowerCase();
  if (driver === "s3") {
    const need = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
    const missing = need.filter((k) => !process.env[k]);
    if (missing.length) throw new Error(`STORAGE_DRIVER=s3 needs ${missing.join(", ")}`);
    cached = new S3Storage({
      endpoint: process.env.S3_ENDPOINT!,
      region: process.env.S3_REGION!,
      bucket: process.env.S3_BUCKET!,
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    });
  } else {
    // The storage directory is configuration, not part of the build: keep it out of file tracing.
    cached = new FsStorage(path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.STORAGE_DIR ?? "./storage"));
  }
  return cached;
}

/** Tests replace the storage. */
export function setStorageForTests(s: Storage | null) {
  cached = s;
}
