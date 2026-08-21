// Photographs: making them small enough to carry, and turning them into
// something a PDF can hold.
//
// WHY DOWNSCALE AT ALL. A photo straight off a 12MP iPhone is 3–5 MB. A heavy
// inspection day is 15 sites, and if photos become a tap they will be taken
// freely — six per site is 90 photos, which at full size is over 300 MB sitting
// in IndexedDB waiting for a signal, on a device iOS is already willing to
// evict. At a 1600px long edge and JPEG quality 0.8 the same day is around
// 36 MB. An inspection photo documents a worn thimble or a cracked timber;
// 1600px is more than the report will ever print and more than anyone will
// zoom to.
//
// EXIF ORIENTATION is handled by `createImageBitmap` with
// `imageOrientation: 'from-image'`, which is why this does not use an <img>.
// Without it, photos taken in portrait on an iPad come out sideways — and they
// would come out sideways in the report too, where it is much more embarrassing.

/** The long edge a stored photo is reduced to. */
export const STORE_EDGE = 1600;
/** The long edge used inside the report — printed at ~3in, so this is generous. */
export const REPORT_EDGE = 1000;

const JPEG_QUALITY = 0.8;

async function bitmapOf(source) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(source, { imageOrientation: 'from-image' }); }
    catch { /* older Safari rejects the options bag — fall through */ }
    try { return await createImageBitmap(source); } catch { /* fall through */ }
  }
  // Last resort: an <img>, which ignores EXIF orientation on some browsers.
  const url = URL.createObjectURL(source);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('That image could not be read.'));
      el.src = url;
    });
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

function draw(bitmap, maxEdge) {
  const w = bitmap.width || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  // White rather than transparent: a JPEG has no alpha, and an unfilled canvas
  // turns a transparent PNG's background black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Shrink an image file for storage. Returns a Blob, or the original if it is
 * not an image this browser can decode — never throws away the photo.
 */
export async function downscaleImage(file, maxEdge = STORE_EDGE) {
  if (!file || !String(file.type || '').startsWith('image/')) return file;
  try {
    const bitmap = await bitmapOf(file);
    const canvas = draw(bitmap, maxEdge);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
    // A "shrunk" file that came out larger is not an improvement.
    if (!blob || blob.size >= file.size) return file;
    return blob;
  } catch {
    // A HEIC this browser will not decode, a corrupt file, a canvas that ran out
    // of memory. The original still uploads; it is just bigger.
    return file;
  }
}

/** An image blob as a data: URI, which is the only form pdfmake accepts. */
export async function toDataUrl(blob, maxEdge = REPORT_EDGE) {
  const bitmap = await bitmapOf(blob);
  return draw(bitmap, maxEdge).toDataURL('image/jpeg', JPEG_QUALITY);
}

/** A photo's name with a JPEG extension, since downscaling makes it one. */
export function jpegName(name) {
  const base = String(name || 'photo').replace(/\.[^.]+$/, '');
  return `${base || 'photo'}.jpg`;
}
