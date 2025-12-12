import jpeg from "jpeg-js";

/**
 * CORONAL HOLE LOCATOR (JPEG Version WITH OVERLAY)
 *
 * Uses AIA 193 JPG from suntoday.lmsal.com, decodes it with jpeg-js,
 * downscales, detects CH edges, overlays polygon pixels in cyan,
 * and returns JSON + a BMP preview.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Optional: /?date=YYYY/MM/DD
    const date = url.searchParams.get("date") || "2025/12/11";

    const IMAGE_URL =
      `https://suntoday.lmsal.com/sdomedia/SunInTime/${date}/f0193.jpg`;

    const TARGET_SIZE = 512;
    const CH_THRESHOLD = 80; // lower = darker
    const SOLAR_RADIUS = 0.46;

    // 1. Fetch image
    const resp = await fetch(IMAGE_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (Compatible; CoronalHoleWorker/1.0)" },
      redirect: "follow"
    });

    if (!resp.ok) {
      return jsonError(502, {
        status: "error",
        message: "Failed to fetch JPEG",
        upstream_status: resp.status,
        upstream_status_text: resp.statusText,
        url: resp.url
      });
    }

    const jpgBuffer = await resp.arrayBuffer();
    const jpgUint8 = new Uint8Array(jpgBuffer);

    // 2. Decode JPEG to RGBA
    let decoded;
    try {
      decoded = jpeg.decode(jpgUint8, { useTArray: true });
    } catch (e) {
      return jsonError(500, {
        status: "error",
        message: "Failed to decode JPEG",
        error: e?.message
      });
    }

    const { width, height, data } = decoded;

    // 3. Downscale + grayscale + log transform
    const step = Math.max(1, Math.floor(width / TARGET_SIZE));
    const outW = Math.floor(width / step);
    const outH = Math.floor(height / step);

    const grayPixels = new Uint8Array(outW * outH);

    let ptr = 0;
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const sx = x * step;
        const sy = y * step;
        const idx = (sy * width + sx) * 4;

        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        let lum = 0.299 * r + 0.587 * g + 0.114 * b;
        lum = Math.log1p(lum) / Math.log1p(255) * 255;

        grayPixels[ptr++] = lum;
      }
    }

    // 4. Detect coronal hole edges
    const polygons = [];
    const centerX = outW / 2;
    const centerY = outH / 2;
    const maxRadiusSq = (outW * SOLAR_RADIUS) ** 2;

    for (let y = 1; y < outH - 1; y++) {
      for (let x = 1; x < outW - 1; x++) {
        const idx = y * outW + x;

        const dx = x - centerX;
        const dy = y - centerY;

        if (dx * dx + dy * dy > maxRadiusSq) continue;

        const v = grayPixels[idx];

        if (v < CH_THRESHOLD) {
          const isEdge =
            grayPixels[idx - 1] >= CH_THRESHOLD ||
            grayPixels[idx + 1] >= CH_THRESHOLD ||
            grayPixels[idx - outW] >= CH_THRESHOLD ||
            grayPixels[idx + outW] >= CH_THRESHOLD;

          if (isEdge) {
            polygons.push({ x: x * step, y: y * step });
          }

          grayPixels[idx] = 0;
        }
      }
    }

    // 5. Encode BMP with polygon overlay
    const bmpData = encodeBMPWithOverlay(grayPixels, outW, outH, polygons, step);
    const base64Img = uint8ToBase64(new Uint8Array(bmpData));

    // 6. Respond
    return new Response(
      JSON.stringify(
        {
          status: "success",
          source: resp.url,
          timestamp: new Date().toISOString(),
          original_dimensions: { width, height },
          processed_dimensions: { width: outW, height: outH, step },
          polygon_count: polygons.length,
          coronal_holes_polygons: polygons,
          image_data: `data:image/bmp;base64,${base64Img}`
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
  }
};

/* -------------------- HELPERS -------------------- */

function jsonError(status, obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

/**
 * Encode a grayscale image into BMP and draw coronal-hole polygons in cyan.
 */
function encodeBMPWithOverlay(grayPixels, w, h, polygons, step) {
  const rowSize = w * 3;
  const paddedRowSize = Math.floor((rowSize + 3) / 4) * 4;
  const fileSize = 54 + paddedRowSize * h;

  const buffer = new ArrayBuffer(fileSize);
  const v = new DataView(buffer);

  // BMP header
  v.setUint8(0, 0x42);
  v.setUint8(1, 0x4d);
  v.setUint32(2, fileSize, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, -h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);

  // Build overlay mask
  const mask = new Uint8Array(w * h);
  for (const p of polygons) {
    const gx = Math.floor(p.x / step);
    const gy = Math.floor(p.y / step);
    if (gx >= 0 && gx < w && gy >= 0 && gy < h) {
      mask[gy * w + gx] = 1;
    }
  }

  // Fill BMP data
  const bmp = new Uint8Array(buffer, 54);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const val = grayPixels[i];

      const pos = y * paddedRowSize + x * 3;

      if (mask[i]) {
        // Overlay polygon pixel in cyan
        bmp[pos] = 255;      // B
        bmp[pos + 1] = 255;  // G
        bmp[pos + 2] = 0;    // R
      } else {
        // Normal grayscale
        bmp[pos] = val;
        bmp[pos + 1] = val;
        bmp[pos + 2] = val;
      }
    }
  }

  return buffer;
}

function uint8ToBase64(u8Arr) {
  const CHUNK = 0x8000;
  let index = 0;
  let out = "";

  while (index < u8Arr.length) {
    const slice = u8Arr.subarray(index, index + CHUNK);
    out += String.fromCharCode.apply(null, slice);
    index += CHUNK;
  }
  return btoa(out);
}
