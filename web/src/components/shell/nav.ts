export const NAV = [
  { href: "/", label: "Trade" },
  { href: "/borrow/", label: "Borrow" },
  { href: "/lend/", label: "Lend" },
  { href: "/resolve/", label: "Resolve" },
  { href: "/admin/", label: "Admin" },
] as const;

/** usePathname with or without the trailing slash the static export adds. */
export const samePath = (path: string | null, href: string) => {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return norm(path ?? "/") === norm(href);
};
