import UPNG from "upng-js";

/**
 * Coronal Hole Locator Worker
 * Returns: 
 *  - /img → PNG image with polygons
 *  - /    → JSON summary
 */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // Route: direct PNG image output
    if (url.pathname === "/img") {
      const png = await generatePNG();
      return new Response(png, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "no-store"
        }
      });
    }

    // Default: JSON output
    const { pngBase64, polys } = await generatePNG(true);
    return Response.json({
      status: "success",
      polygons: polys,
      image_data: `data:image/png;base64,${pngBase64}`
    });
  }
};

/* -------------------------------------------------------
   IMAGE GENERATION (PNG + Polygon overlay)
--------------------------------------------------------*/

async function generatePNG(returnBase64 = false) {

  // Load the 193Å image
  const IMG_URL = "https://suntoday.lmsal.com/sdomedia/SunInTime/2025/12/11/f0193.jpg";

  const imgResp = await fetch(IMG_URL);
  if (!imgResp.ok) throw new Error("Cannot fetch source image");

  const arrayBuf = await imgResp.arrayBuffer();
  const jpeg = new Uint8Array(arrayBuf);

  // Decode JPEG manually using browser Image (Workers support this)
  const bitmap = await createImageBitmap(new Blob([jpeg]));

  const W = bitmap.width;
  const H = bitmap.height;

  // Prepare raw RGBA buffer
  const rgba = new Uint8Array(W * H * 4);

  // Draw to OFFSCREEN CANVAS (supported in Workers!)
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  const imgData = ctx.getImageData(0, 0, W, H);
  rgba.set(imgData.data);

  // VERY SIMPLE “coronal hole” threshold demo (solid dark patches)
  const threshold = 40;
  const polys = [];

  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      const brightness = rgba[i]; // grayscale-ish (R channel)

      if (brightness < threshold) {
        // Mark polygon border pixels in cyan
        rgba[i] = 0;
        rgba[i + 1] = 255;
        rgba[i + 2] = 255;
        rgba[i + 3] = 255;

        polys.push({ x, y });
      }
    }
  }

  // Encode back to PNG
  const png = UPNG.encode([rgba.buffer], W, H, 256);

  if (returnBase64) {
    const b64 = uint8ToBase64(new Uint8Array(png));
    return { pngBase64: b64, polys };
  }

  return png;
}

/* -------------------------------------------------------
   BASE64 utility
--------------------------------------------------------*/
function uint8ToBase64(arr) {
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}
