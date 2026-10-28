// The user's picture (a data: URL, drawn only through <img>) or their initial.
export function Avatar({ name, image, size = 24 }: { name: string; image?: string | null; size?: number }) {
  const box = { width: size, height: size, fontSize: size * 0.45 };
  return image
    ? <img src={image} alt="" style={box} className="shrink-0 rounded-full object-cover" />
    : <span aria-hidden style={box} className="grid shrink-0 place-items-center rounded-full bg-foreground/10 font-semibold">{name.slice(0, 1).toUpperCase()}</span>;
}
