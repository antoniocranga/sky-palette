/** Curation and kill-switch behaviour: the human controls around uploads. */

import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import {
  fileFrom,
  jpegFixture,
  mockUpstream,
  openMeteoHandler,
  submissionForm,
  testEnv,
  withEnvVar,
} from "./helpers";

const BASE = "https://skypalette.test";
const TOKEN = "test-admin-token-0123456789";

async function upload(ip = "203.0.113.150"): Promise<string> {
  mockUpstream(openMeteoHandler());
  const response = await SELF.fetch(`${BASE}/api/submit`, {
    method: "POST",
    body: submissionForm({ photo: fileFrom(jpegFixture(1200, 800), "sky.jpg", "image/jpeg") }),
    headers: { "cf-connecting-ip": ip },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { submissionId: string };
  return body.submissionId;
}

function admin(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/api/admin/submissions/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
}

async function galleryCount(): Promise<number> {
  const response = await SELF.fetch(`${BASE}/api/gallery?lat=44.4268&lon=26.1025`);
  const body = (await response.json()) as { photos: unknown[] };
  return body.photos.length;
}

describe("/api/admin", () => {
  it("is invisible when no token is configured", async () => {
    await withEnvVar("ADMIN_TOKEN", undefined, async () => {
      const id = await upload();
      const response = await admin(id, { method: "PATCH", body: JSON.stringify({ status: "approved" }) });
      expect(response.status).toBe(404);
    });
  });

  it("rejects a wrong bearer token", async () => {
    await withEnvVar("ADMIN_TOKEN", TOKEN, async () => {
      const id = await upload();
      const response = await SELF.fetch(`${BASE}/api/admin/submissions/${id}`, {
        method: "PATCH",
        headers: { authorization: "Bearer wrong-token-wrong-token" },
        body: JSON.stringify({ status: "approved" }),
      });
      expect(response.status).toBe(401);
    });
  });

  it("approves a pending upload so it appears in the gallery, then rejects it", async () => {
    await withEnvVar("ADMIN_TOKEN", TOKEN, async () => {
      const id = await upload("203.0.113.151");
      expect(await galleryCount()).toBe(0);

      const approved = await admin(id, { method: "PATCH", body: JSON.stringify({ status: "approved" }) });
      expect(approved.status).toBe(200);
      expect(await galleryCount()).toBe(1);

      const rejected = await admin(id, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) });
      expect(rejected.status).toBe(200);
      expect(await galleryCount()).toBe(0);
    });
  });

  it("validates the status value", async () => {
    await withEnvVar("ADMIN_TOKEN", TOKEN, async () => {
      const id = await upload("203.0.113.152");
      const response = await admin(id, { method: "PATCH", body: JSON.stringify({ status: "published" }) });
      expect(response.status).toBe(400);
    });
  });

  it("deletes the row from D1 and the object from R2", async () => {
    await withEnvVar("ADMIN_TOKEN", TOKEN, async () => {
      const id = await upload("203.0.113.153");
      const row = await testEnv.DB.prepare("SELECT r2_key FROM submissions WHERE id = ?")
        .bind(id)
        .first<{ r2_key: string }>();
      expect(row).not.toBeNull();
      expect(await testEnv.PHOTOS.get(row!.r2_key)).not.toBeNull();

      const response = await admin(id, { method: "DELETE" });
      expect(response.status).toBe(204);

      const after = await testEnv.DB.prepare("SELECT id FROM submissions WHERE id = ?").bind(id).first();
      expect(after).toBeNull();
      expect(await testEnv.PHOTOS.get(row!.r2_key)).toBeNull();
    });
  });
});

describe("upload kill switch", () => {
  it("returns 503 while reads keep working", async () => {
    await withEnvVar("UPLOADS_ENABLED", "false", async () => {
      const response = await SELF.fetch(`${BASE}/api/submit`, {
        method: "POST",
        body: submissionForm({ photo: fileFrom(jpegFixture(1200, 800), "sky.jpg", "image/jpeg") }),
        headers: { "cf-connecting-ip": "203.0.113.160" },
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("3600");

      const palette = await SELF.fetch(`${BASE}/api/config`);
      expect(palette.status).toBe(200);
    });
  });
});
