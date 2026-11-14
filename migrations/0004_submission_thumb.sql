-- Gallery thumbnail variant.
--
-- Uploads are downscaled client-side to <=1600 px, which is still large for a
-- 15/30-tile mosaic. The client also sends a 400 px variant; older rows keep
-- NULL and fall back to the full image.

ALTER TABLE submissions ADD COLUMN thumb_key TEXT;
