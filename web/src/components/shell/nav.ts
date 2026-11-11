export const NAV = [{ href: "/", label: "Trade" }] as const;

/** usePathname with or without the trailing slash the static export adds. */
export const samePath = (path: string | null, href: string) => {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return norm(path ?? "/") === norm(href);
};
