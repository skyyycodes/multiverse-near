/** The desktop header's screens; the phone reaches the order book through its More menu. */
export const NAV = [
  { href: "/", label: "Trade", demo: "nav-trade" },
  { href: "/orders/", label: "Order book", demo: "nav-orders" },
  { href: "/borrow/", label: "Borrow", demo: "nav-borrow" },
  { href: "/lend/", label: "Lend", demo: "nav-lend" },
  { href: "/resolve/", label: "Resolve", demo: "nav-resolve" },
  { href: "/admin/", label: "Admin", demo: "nav-admin" },
] as const;

/** usePathname with or without the trailing slash the static export adds. */
export const samePath = (path: string | null, href: string) => {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return norm(path ?? "/") === norm(href);
};
