import jpeg from "jpeg-js";

/**
 * CORONAL HOLE LOCATOR (JPEG Version)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Optional: ?date=YYYY/MM/DD   (default is the date from your example)
    const date = url.searchParams.get("date") || "2025/12/11";

    const IMAGE_URL =
      `https://suntoday.lmsal.com/sdomedia/SunInTime/${date}/f0193.jpg`;

    const TARGET_SIZE = 512;
    const CH_THRESHOLD = 80;
    const SOLAR_RADIUS = 0.46;

    // 1. Fetch JPEG
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

    // 2. Decode JPEG -> RGBA
    let decoded;
    try {
      decoded = jpeg.decode(jpgUint8, { useTArray: true });
    } catch (e) {
      return jsonError(500, {
        status: "error",
        message: "Failed to decode JPEG",
        error: e && e.message
      });
    }

    const { width, height, data } = decoded;

    // 3. Downsample + grayscale + mild log
    const step = Math.max(1, Math.floor(width / TARGET_SIZE));
    const outW = Math.floor(width / step);
    const outH = Math.floor(height / step);
    const grayPixels = new Uint8Array(outW * outH);

    let ptr = 0;
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const sx = x * step;
        const sy = y * step;
        const srcIdx = (sy * width + sx) * 4;

        const r = data[srcIdx];
        const g = data[srcIdx + 1];
        const b = data[srcIdx + 2];

        let lum = 0.299 * r + 0.587 * g + 0.114 * b;
        lum = Math.log1p(lum) / Math.log1p(255) * 255;

        grayPixels[ptr++] = lum;
      }
    }

    // 4. Coronal-hole edge detection
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

        const val = grayPixels[idx];

        if (val < CH_THRESHOLD) {
          const isEdge =
            grayPixels[idx - 1] >= CH_THRESHOLD ||
            grayPixels[idx + 1] >= CH_THRESHOLD ||
            grayPixels[idx - outW] >= CH_THRESHOLD ||
            grayPixels[idx + outW] >= CH_THRESHOLD;

          if (isEdge) {
            polygons.push({
              x: x * step,
              y: y * step
            });
          }

          grayPixels[idx] = 0;
        }
      }
    }

    // 5. BMP preview
    const bmpData = encodeBMP(grayPixels, outW, outH);
    const base64Img = uint8ToBase64(new Uint8Array(bmpData));

    // 6. Response
    return new Response(
      JSON.stringify(
        {
          status: "success",
          source: resp.url,
          timestamp: new Date().toISOString(),
          original_dimensions: { w: width, h: height },
          analysis_grid: { w: outW, h: outH, step },
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

function jsonError(status, obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function encodeBMP(pixels, w, h) {
  const rowSize = w * 3;
  const paddedRowSize = Math.floor((rowSize + 3) / 4) * 4;
  const fileSize = 54 + paddedRowSize * h;
  const buffer = new ArrayBuffer(fileSize);
  const v = new DataView(buffer);

  v.setUint8(0, 0x42);
  v.setUint8(1, 0x4d);
  v.setUint32(2, fileSize, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, -h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);

  const data = new Uint8Array(buffer, 54);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const val = pixels[i];
      const pos = y * paddedRowSize + x * 3;
      data[pos] = val;
      data[pos + 1] = val;
      data[pos + 2] = val;
    }
  }

  return buffer;
}

function uint8ToBase64(u8Arr) {
  const CHUNK_SIZE = 0x8000;
  let index = 0;
  const length = u8Arr.length;
  let result = "";
  while (index < length) {
    const slice = u8Arr.subarray(index, Math.min(index + CHUNK_SIZE, length));
    result += String.fromCharCode.apply(null, slice);
    index += CHUNK_SIZE;
  }
  return btoa(result);
}
