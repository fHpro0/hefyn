export type Brand = { name: string; logo: string | null; logoDark: string | null };

// The company part of the lockup exists only with a logo or a name.
export const hasBrand = (b?: Brand | null): b is Brand => !!b && !!(b.logo || b.name);
export const brandHome = (b?: Brand | null) => (hasBrand(b) && b.name ? `hefyn × ${b.name} home` : 'hefyn home');
