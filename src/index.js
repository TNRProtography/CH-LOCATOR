import jpeg from "jpeg-js";
import UPNG from "upng-js";

/**
 * Coronal Hole Locator Worker (PNG + /img endpoint)
 *
 * - GET /img  -> image/png (PNG with cyan CH edges)
 * - GET /     -> JSON with polygons + base64 PNG
 */

const TARGET_SIZE = 512;   // analysis size
const CH_THRESHOLD = 80;   // grayscale threshold for "dark"
const SOLAR_RADIUS = 0.46; // fraction of width for disk mask

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      // Generate image + polygons
      const result = await generateCoronalHolePNG();

      // Route: /img -> raw PNG
      if (url.pathname === "/img") {
        return new Response(result.pngBuffer, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "no-store"
          }
        });
      }

      // Default: JSON
      return new Response(
        JSON.stringify(
          {
            status: "success",
            source: result.source,
            timestamp: result.timestamp,
            original_dimensions: result.originalDimensions,
            processed_dimensions: result.processedDimensions,
            polygon_count: result.polygons.length,
            coronal_holes_polygons: result.polygons,
            image_data: `data:image/png;base64,${result.base64}`
          },
          null,
          2
        ),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    } catch (e) {
      console.error("Worker error:", e);

      return new Response(
        JSON.stringify(
          {
            status: "error",
            message: "Worker threw exception",
            error: e && e.message
          },
          null,
          2
        ),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }
  }
};

/**
 * Fetches the AIA 193 JPEG, detects CH edges, overlays them in cyan,
 * and returns a PNG buffer + metadata.
 */
async function generateCoronalHolePNG() {
  // For now use the fixed date you gave. We can later parameterise this.
  const DATE_PATH = "2025/12/11";
  const IMAGE_URL = `https://suntoday.lmsal.com/sdomedia/SunInTime/${DATE_PATH}/f0193.jpg`;

  const resp = await fetch(IMAGE_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (Compatible; CH-Locator/1.0)" },
    redirect: "follow"
  });

  if (!resp.ok) {
    throw new Error(
      `Failed to fetch JPEG: ${resp.status} ${resp.statusText} (${IMAGE_URL})`
    );
  }

  const jpegBytes = new Uint8Array(await resp.arrayBuffer());

  // Decode JPEG using jpeg-js (pure JS)
  const decoded = jpeg.decode(jpegBytes, { useTArray: true });
  const { width, height, data } = decoded; // data = RGBA Uint8Array

  // Downscale to TARGET_SIZE (or smaller)
  const step = Math.max(1, Math.floor(width / TARGET_SIZE));
  const outW = Math.floor(width / step);
  const outH = Math.floor(height / step);

  // RGBA buffer for output image
  const rgba = new Uint8Array(outW * outH * 4);

  // 1. Create grayscale/log image
  let dst = 0;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const sx = x * step;
      const sy = y * step;
      const srcIdx = (sy * width + sx) * 4;

      const r = data[srcIdx];
      const g = data[srcIdx + 1];
      const b = data[srcIdx + 2];

      // luminance + mild log compression
      let lum = 0.299 * r + 0.587 * g + 0.114 * b;
      lum = Math.log1p(lum) / Math.log1p(255) * 255;
      lum = lum < 0 ? 0 : lum > 255 ? 255 : lum;

      rgba[dst++] = lum;
      rgba[dst++] = lum;
      rgba[dst++] = lum;
      rgba[dst++] = 255; // alpha
    }
  }

  // 2. Coronal hole edge detection and overlay
  const centerX = outW / 2;
  const centerY = outH / 2;
  const maxRadiusSq = (outW * SOLAR_RADIUS) ** 2;
  const polygons = [];

  function getLumAt(x, y) {
    const idx = (y * outW + x) * 4;
    return rgba[idx]; // R channel (grayscale)
  }

  function setPixel(x, y, R, G, B) {
    const idx = (y * outW + x) * 4;
    rgba[idx] = R;
    rgba[idx + 1] = G;
    rgba[idx + 2] = B;
    rgba[idx + 3] = 255;
  }

  for (let y = 1; y < outH - 1; y++) {
    for (let x = 1; x < outW - 1; x++) {
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy > maxRadiusSq) continue;

      const lum = getLumAt(x, y);
      if (lum < CH_THRESHOLD) {
        const isEdge =
          getLumAt(x - 1, y) >= CH_THRESHOLD ||
          getLumAt(x + 1, y) >= CH_THRESHOLD ||
          getLumAt(x, y - 1) >= CH_THRESHOLD ||
          getLumAt(x, y + 1) >= CH_THRESHOLD;

        if (isEdge) {
          // Store polygon coordinate in original-image scale
          polygons.push({ x: x * step, y: y * step });

          // Overlay in cyan
          setPixel(x, y, 0, 255, 255);
        }
      }
    }
  }

  // 3. Encode PNG using UPNG.js
  const pngArrayBuffer = UPNG.encode([rgba.buffer], outW, outH, 0);
  const pngUint8 = new Uint8Array(pngArrayBuffer);
  const base64 = uint8ToBase64(pngUint8);

  return {
    pngBuffer: pngArrayBuffer,
    base64,
    polygons,
    source: resp.url,
    timestamp: new Date().toISOString(),
    originalDimensions: { width, height },
    processedDimensions: { width: outW, height: outH, step }
  };
}

function uint8ToBase64(u8) {
  const CHUNK = 0x8000;
  let index = 0;
  let result = "";
  while (index < u8.length) {
    const slice = u8.subarray(index, Math.min(index + CHUNK, u8.length));
    result += String.fromCharCode.apply(null, slice);
    index += CHUNK;
  }
  return btoa(result);
}
