/** Grid thumbnail variants: optional, non-blocking, and never breaking a submission. */

import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import {
  fileFrom,
  jpegFixture,
  mockUpstream,
  openMeteoHandler,
  submissionForm,
  testEnv,
  webpFixture,
} from "./helpers";

const BASE = "https://skypalette.test";

async function submit(thumb?: File): Promise<{ id: string; url: string }> {
  const form = submissionForm({ photo: fileFrom(jpegFixture(1200, 800), "sky.jpg", "image/jpeg") });
  if (thumb) form.set("thumb", thumb);
  const response = await SELF.fetch(`${BASE}/api/submit`, {
    method: "POST",
    body: form,
    headers: { "cf-connecting-ip": `203.0.113.${Math.floor(Math.random() * 200) + 20}` },
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { submissionId: string; url: string };
  return { id: body.submissionId, url: body.url };
}

async function galleryThumb(): Promise<string> {
  await testEnv.DB.prepare("UPDATE submissions SET status = 'approved'").run();
  const response = await SELF.fetch(`${BASE}/api/gallery?lat=44.4268&lon=26.1025`);
  const body = (await response.json()) as { photos: Array<{ url: string; thumbUrl: string }> };
  expect(body.photos).toHaveLength(1);
  return body.photos[0]!.thumbUrl;
}

describe("gallery thumbnails", () => {
  it("stores a variant and serves it from the gallery", async () => {
    mockUpstream(openMeteoHandler());
    await submit(fileFrom(webpFixture(400, 400), "thumb.webp", "image/webp"));

    const row = await testEnv.DB.prepare("SELECT thumb_key FROM submissions").first<{ thumb_key: string | null }>();
    expect(row?.thumb_key).toMatch(/^photos\/\d{4}\/\d{2}\/thumb-[0-9a-f-]{36}\.webp$/);
    expect(await testEnv.PHOTOS.get(row!.thumb_key!)).not.toBeNull();

    const thumbUrl = await galleryThumb();
    expect(thumbUrl).toContain("thumb-");
  });

  it("falls back to the full image when no variant is sent", async () => {
    mockUpstream(openMeteoHandler());
    const { url } = await submit();

    const thumbUrl = await galleryThumb();
    expect(thumbUrl).toBe(url);
  });

  it("ignores an invalid thumb instead of rejecting the upload", async () => {
    mockUpstream(openMeteoHandler());
    await submit(fileFrom(webpFixture(100, 100), "thumb.webp", "image/webp"));

    const row = await testEnv.DB.prepare("SELECT thumb_key FROM submissions").first<{ thumb_key: string | null }>();
    expect(row?.thumb_key).toBeNull();
    const thumbUrl = await galleryThumb();
    expect(thumbUrl).not.toContain("thumb-");
  });
});
