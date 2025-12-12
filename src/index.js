import jpeg from "jpeg-js";
import UPNG from "upng-js";

/**
 * CORONAL HOLE LOCATOR (PNG OUTPUT)
 * 
 * - Fetch JPEG AIA193
 * - Decode JPEG to RGBA
 * - Downscale + grayscale
 * - Detect coronal-hole edges
 * - Overlay polygon in cyan
 * - Export PNG (base64)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Date folder path: YYYY/MM/DD
    const date = url.searchParams.get("date") || "2025/12/11";

    const IMAGE_URL =
      `https://suntoday.lmsal.com/sdomedia/SunInTime/${date}/f0193.jpg`;

    const TARGET_SIZE = 512;
    const CH_THRESHOLD = 80;
    const SOLAR_RADIUS = 0.46;

    // 1. Fetch upstream image
    const resp = await fetch(IMAGE_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (Compatible; SolarCH-Worker/1.0)" },
      redirect: "follow"
    });

    if (!resp.ok) {
      return jsonError(502, {
        status: "error",
        message: "Failed to fetch upstream JPEG",
        upstream_status: resp.status,
        upstream_status_text: resp.statusText,
        url: resp.url
      });
    }

    const jpegBuffer = new Uint8Array(await resp.arrayBuffer());

    // 2. Decode JPEG
    let decoded;
    try {
      decoded = jpeg.decode(jpegBuffer, { useTArray: true });
    } catch (e) {
      return jsonError(500, { status: "error", message: "jpeg-js decode failed", error: e.message });
    }

    const { width, height, data } = decoded; // RGBA

    // 3. Downscale + grayscale
    const step = Math.max(1, Math.floor(width / TARGET_SIZE));
    const outW = Math.floor(width / step);
    const outH = Math.floor(height / step);

    // RGBA target buffer (for PNG)
    const rgba = new Uint8Array(outW * outH * 4);

    let p = 0;
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const sx = x * step;
        const sy = y * step;
        const idx = (sy * width + sx) * 4;

        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        let lum = 0.299*r + 0.587*g + 0.114*b;
        lum = Math.log1p(lum) / Math.log1p(255) * 255;
        lum = Math.max(0, Math.min(255, lum));

        rgba[p++] = lum; // R
        rgba[p++] = lum; // G
        rgba[p++] = lum; // B
        rgba[p++] = 255; // A
      }
    }

    // 4. Coronal hole edge detection
    const polygons = [];
    const centerX = outW / 2;
    const centerY = outH / 2;
    const maxRadiusSq = (outW * SOLAR_RADIUS) ** 2;

    function getLumAt(x, y) {
      const id = (y * outW + x) * 4;
      return rgba[id]; // grayscale R
    }

    function setPixel(x, y, R, G, B) {
      const id = (y * outW + x) * 4;
      rgba[id] = R;
      rgba[id + 1] = G;
      rgba[id + 2] = B;
      rgba[id + 3] = 255;
    }

    for (let y = 1; y < outH - 1; y++) {
      for (let x = 1; x < outW - 1; x++) {
        const dx = x - centerX;
        const dy = y - centerY;

        if (dx*dx + dy*dy > maxRadiusSq) continue;

        const lum = getLumAt(x, y);
        if (lum < CH_THRESHOLD) {
          const isEdge =
            getLumAt(x-1, y) >= CH_THRESHOLD ||
            getLumAt(x+1, y) >= CH_THRESHOLD ||
            getLumAt(x, y-1) >= CH_THRESHOLD ||
            getLumAt(x, y+1) >= CH_THRESHOLD;

          if (isEdge) {
            polygons.push({ x: x * step, y: y * step });
            setPixel(x, y, 0, 255, 255); // Cyan polygon overlay
          }
        }
      }
    }

    // 5. Export PNG using UPNG.js
    const pngBuff = UPNG.encode([rgba.buffer], outW, outH, 0);
    const b64 = uint8ToBase64(new Uint8Array(pngBuff));

    return new Response(
      JSON.stringify(
        {
          status: "success",
          source: resp.url,
          timestamp: new Date().toISOString(),
          original_dimensions: { width, height },
          processed_dimensions: { outW, outH, step },
          polygon_count: polygons.length,
          coronal_holes_polygons: polygons,
          image_data: `data:image/png;base64,${b64}`
        },
        null, 2),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }
};

/* ---------------- HELPERS ---------------- */

function jsonError(code, obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: code,
    headers: { "Content-Type": "application/json" }
  });
}

function uint8ToBase64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
