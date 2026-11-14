/** The desktop header's global screens (web design 3.4); a market's own screens are its tabs. */
export const NAV = [
  { href: "/", label: "Markets", demo: "nav-markets", match: /^\/($|\?|market|sell|orders|split|world|borrow|lend|resolve)/ },
  { href: "/liquidate/", label: "At-risk loans", demo: "nav-liquidate" },
  { href: "/propose/", label: "Propose", demo: "nav-propose", match: /^\/(propose|proposal)/ },
  { href: "/admin/", label: "Admin", demo: "nav-admin" },
] as const;

export type NavItem = { href: string; label: string; demo: string; match?: RegExp };

/** usePathname with or without the trailing slash the static export adds. */
export const samePath = (path: string | null, href: string) => {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return norm(path ?? "/") === norm(href);
};

/** A link is current on its own path, and for Markets and Propose on the screens under them. */
export const isCurrent = (path: string | null, n: NavItem) => samePath(path, n.href) || Boolean(n.match?.test(path ?? "/"));
