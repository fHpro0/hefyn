// A profile picture is a small raster data: URL (never SVG: it is only ever drawn through <img>, but a user-set value stays dumb).
const MAX_BYTES = 256 * 1024;
const AVATAR = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/** Why `image` is not an acceptable avatar, or undefined. null / '' (remove it) is fine. */
export function avatarError(image: unknown): string | undefined {
  if (image == null || image === '') return undefined;
  const m = typeof image === 'string' ? AVATAR.exec(image) : null;
  if (!m) return 'The picture must be a PNG, JPEG or WebP image.';
  if (m[2]!.length * 0.75 > MAX_BYTES) return 'The picture must be 256 KB or less.';
}
