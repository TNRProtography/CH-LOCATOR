import jpeg from "jpeg-js";
import UPNG from "upng-js";

/**
 * Coronal Hole Locator Worker (FULL COLOUR + LINED POLYGONS)
 *
 * - GET /img  -> image/png (colour 193Å with cyan CH outlines)
 * - GET /     -> JSON with polygons + contours + base64 PNG
 */

const TARGET_SIZE = 512;    // analysis size
const CH_THRESHOLD = 50;    // stricter luminance threshold (less sensitive)
const SOLAR_RADIUS = 0.43;  // fraction of width for disk mask

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      const result = await generateCoronalHolePNG();

      if (url.pathname === "/img") {
        // Raw PNG for direct viewing
        return new Response(result.pngBuffer, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "no-store"
          }
        });
      }

      // JSON (debug/other uses)
      return new Response(
        JSON.stringify(
          {
            status: "success",
            source: result.source,
            timestamp: result.timestamp,
            original_dimensions: result.originalDimensions,
            processed_dimensions: result.processedDimensions,
            polygon_count: result.edgePoints.length,
            coronal_holes_polygons: result.edgePoints,
            contours_scaled: result.contoursScaled,
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
 * Fetch AIA 193 JPEG, detect CH edges using luminance, group them into
 * contours, draw outlines on the ORIGINAL colour image, and return PNG.
 */
async function generateCoronalHolePNG() {
  const DATE_PATH = "2025/12/11"; // fixed for now
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

  // Decode JPEG -> RGBA
  const decoded = jpeg.decode(jpegBytes, { useTArray: true });
  const { width, height, data } = decoded; // data = RGBA

  // Downscale
  const step = Math.max(1, Math.floor(width / TARGET_SIZE));
  const outW = Math.floor(width / step);
  const outH = Math.floor(height / step);

  // Output colour buffer
  const rgba = new Uint8Array(outW * outH * 4);
  // Luminance buffer for CH detection
  const lumBuf = new Uint8Array(outW * outH);

  let dst = 0;
  let li = 0;

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const sx = x * step;
      const sy = y * step;
      const srcIdx = (sy * width + sx) * 4;

      const r = data[srcIdx];
      const g = data[srcIdx + 1];
      const b = data[srcIdx + 2];
      const a = data[srcIdx + 3];

      // Keep original colour
      rgba[dst++] = r;
      rgba[dst++] = g;
      rgba[dst++] = b;
      rgba[dst++] = a;

      // Luminance (0–255)
      let lum = 0.299 * r + 0.587 * g + 0.114 * b;
      lum = lum < 0 ? 0 : lum > 255 ? 255 : lum;
      lumBuf[li++] = lum;
    }
  }

  // CH detection on luminance
  const centerX = outW / 2;
  const centerY = outH / 2;
  const maxRadiusSq = (outW * SOLAR_RADIUS) ** 2;

  const edgeMask = new Uint8Array(outW * outH); // 1 where edge pixel
  const edgePoints = []; // scaled to original-res for compatibility

  function getLumAt(x, y) {
    return lumBuf[y * outW + x];
  }

  for (let y = 1; y < outH - 1; y++) {
    for (let x = 1; x < outW - 1; x++) {
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy > maxRadiusSq) continue; // outside disk

      const lum = getLumAt(x, y);
      if (lum < CH_THRESHOLD) {
        const isEdge =
          getLumAt(x - 1, y) >= CH_THRESHOLD ||
          getLumAt(x + 1, y) >= CH_THRESHOLD ||
          getLumAt(x, y - 1) >= CH_THRESHOLD ||
          getLumAt(x, y + 1) >= CH_THRESHOLD;

        if (isEdge) {
          edgeMask[y * outW + x] = 1;
          edgePoints.push({ x: x * step, y: y * step });
        }
      }
    }
  }

  // Extract contours (polylines) from edgeMask
  const contours = extractContours(edgeMask, outW, outH);

  // Draw lines for each contour onto the colour buffer
  for (const contour of contours) {
    for (let i = 1; i < contour.length; i++) {
      const p0 = contour[i - 1];
      const p1 = contour[i];
      drawLine(rgba, outW, outH, p0.x, p0.y, p1.x, p1.y, 0, 255, 255); // cyan
    }
  }

  // Encode PNG
  const pngArrayBuffer = UPNG.encode([rgba.buffer], outW, outH, 0);
  const pngUint8 = new Uint8Array(pngArrayBuffer);
  const base64 = uint8ToBase64(pngUint8);

  // Scale contours back to original-res coordinates for JSON
  const contoursScaled = contours.map(contour =>
    contour.map(p => ({ x: p.x * step, y: p.y * step }))
  );

  return {
    pngBuffer: pngArrayBuffer,
    base64,
    edgePoints,
    contoursScaled,
    source: resp.url,
    timestamp: new Date().toISOString(),
    originalDimensions: { width, height },
    processedDimensions: { width: outW, height: outH, step }
  };
}

/* ---------- contour extraction (very simple chaining) ---------- */

function extractContours(edgeMask, w, h) {
  const visited = new Uint8Array(w * h);
  const contours = [];

  const neighbors = [
    [-1, 0],  // W
    [-1, -1], // NW
    [0, -1],  // N
    [1, -1],  // NE
    [1, 0],   // E
    [1, 1],   // SE
    [0, 1],   // S
    [-1, 1]   // SW
  ];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!edgeMask[idx] || visited[idx]) continue;

      const contour = [];
      let cx = x;
      let cy = y;
      visited[idx] = 1;
      contour.push({ x: cx, y: cy });

      // Simple chain-following
      while (true) {
        let found = false;

        for (let k = 0; k < neighbors.length; k++) {
          const nx = cx + neighbors[k][0];
          const ny = cy + neighbors[k][1];

          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const nIdx = ny * w + nx;
          if (edgeMask[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1;
            contour.push({ x: nx, y: ny });
            cx = nx;
            cy = ny;
            found = true;
            break;
          }
        }

        if (!found) break;
      }

      // Ignore very short contours (noise)
      if (contour.length >= 5) {
        contours.push(contour);
      }
    }
  }

  return contours;
}

/* ---------- drawing helpers ---------- */

function drawLine(rgba, w, h, x0, y0, x1, y1, R, G, B) {
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);

  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1;
  let sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    setPixelColourSafe(rgba, w, h, x0, y0, R, G, B);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}

function setPixelColourSafe(rgba, w, h, x, y, R, G, B) {
  if (x < 0 || x >= w || y < 0 || y >= h) return;
  const idx = (y * w + x) * 4;
  rgba[idx] = R;
  rgba[idx + 1] = G;
  rgba[idx + 2] = B;
  rgba[idx + 3] = 255;
}

/* ---------- misc ---------- */

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
