/** Size after scaling the long side down to `max` (aspect kept, never upscaled). */
export const fitSize = (w: number, h: number, max: number) => {
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)), scaled: k < 1 };
};

/** Downscale and re-encode an image for an Assistant's rules. PNG becomes WebP (keeps transparency); anything that would not get smaller is returned unchanged. */
export async function shrinkImage(file: File, max: number, quality: number): Promise<File> {
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) return file; // gif/svg/heic: leave alone
  try {
    const bmp = await createImageBitmap(file);
    const { width, height, scaled } = fitSize(bmp.width, bmp.height, max);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, width, height);
    bmp.close();
    const type = file.type === 'image/jpeg' || file.type === 'image/jpg' ? 'image/jpeg' : 'image/webp';
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, quality));
    if (!blob || blob.type !== type || (!scaled && blob.size >= file.size)) return file;
    const ext = type === 'image/jpeg' ? 'jpg' : 'webp';
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.' + ext, { type });
  } catch { return file; } // undecodable: the server decides
}
