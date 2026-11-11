// Line icons drawn for this app: verbs about futures, not banking glyphs. 24px grid, 1.6px stroke, currentColor.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 22, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Protect (sell where you fear): a shield split down the middle. */
export const IconProtect = (p: P) => (
  <Svg {...p}>
    <path d="M11 3.4 5 5.7v5.1c0 4.3 2.4 7.6 6 9.4" />
    <path d="M13 3.4 19 5.7v5.1c0 4.3-2.4 7.6-6 9.4" />
    <path d="M9.2 11.6h1.6M13.2 11.6h1.6" opacity=".55" />
  </Svg>
);

/** Back a future (buy where you hope): a path that branches, one branch carried through. */
export const IconBack = (p: P) => (
  <Svg {...p}>
    <path d="M12 20.5v-8" />
    <path d="M12 12.5c0-3.4-2.6-5.6-6.5-6.4" opacity=".45" />
    <path d="M12 12.5c0-3.4 2.6-5.6 6.5-6.4" />
    <path d="M15.4 4.9 18.6 6l-1 3.2" />
  </Svg>
);

/** Borrow: a coin resting on the lattice of worlds. */
export const IconBorrow = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="7.4" r="3.6" />
    <path d="M12 6v2.8" />
    <rect x="4.5" y="13.5" width="15" height="7" rx="1.6" />
    <path d="M12 13.5v7M4.5 17h15" opacity=".55" />
  </Svg>
);

/** Lend: a coin flowing into four slots. */
export const IconLend = (p: P) => (
  <Svg {...p}>
    <circle cx="5.9" cy="12" r="3.2" />
    <path d="M9.8 12h2.6" />
    <path d="m11.2 10.6 1.4 1.4-1.4 1.4" />
    <rect x="14.4" y="7.4" width="3" height="3" rx=".8" />
    <rect x="18.4" y="7.4" width="3" height="3" rx=".8" />
    <rect x="14.4" y="13.6" width="3" height="3" rx=".8" />
    <rect x="18.4" y="13.6" width="3" height="3" rx=".8" />
  </Svg>
);

/** Orders: a bid and an ask facing each other. */
export const IconOrders = (p: P) => (
  <Svg {...p}>
    <path d="M8 4v15.5M4.8 16.4 8 19.6l3.2-3.2" />
    <path d="M16 20V4.5M12.8 7.6 16 4.4l3.2 3.2" />
  </Svg>
);

/** Liquidity: one deposit spread across every world. */
export const IconLiquidity = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5c3 3.6 5.4 6.6 5.4 9.6a5.4 5.4 0 0 1-10.8 0c0-3 2.4-6 5.4-9.6Z" />
    <path d="M12 10.2v6.4M8.8 13.4h6.4" opacity=".6" />
  </Svg>
);

/** Resolve: four paths that collapse into one. */
export const IconResolve = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 5.5c6 0 8 6.5 13 6.5" opacity=".45" />
    <path d="M3.5 9.8c5 0 7.4 2.2 13 2.2" opacity=".45" />
    <path d="M3.5 14.2c5 0 7.4-2.2 13-2.2" opacity=".45" />
    <path d="M3.5 18.5c6 0 8-6.5 13-6.5" />
    <circle cx="19" cy="12" r="1.9" />
  </Svg>
);

export const IconAdmin = (p: P) => (
  <Svg {...p}>
    <path d="M4 7.5h16M4 16.5h16" />
    <circle cx="9" cy="7.5" r="2.1" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="16.5" r="2.1" fill="currentColor" stroke="none" />
  </Svg>
);

/** Trade home: the four futures. */
export const IconFutures = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="7" height="7" rx="2" />
    <rect x="13" y="4" width="7" height="7" rx="2" />
    <rect x="4" y="13" width="7" height="7" rx="2" />
    <rect x="13" y="13" width="7" height="7" rx="2" />
  </Svg>
);

export const IconMore = (p: P) => (
  <Svg {...p}>
    <circle cx="6" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="18" cy="12" r="1.2" fill="currentColor" />
  </Svg>
);

export const IconHelp = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.6 9.6a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6" />
    <circle cx="12" cy="16.9" r=".7" fill="currentColor" />
  </Svg>
);

export const IconBell = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5l1.5-1.5Z" />
    <path d="M10 20a2.2 2.2 0 0 0 4 0" />
  </Svg>
);

export const IconChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="m7 10 5 5 5-5" />
  </Svg>
);

export const IconChevronLeft = (p: P) => (
  <Svg {...p}>
    <path d="m14.5 6-6 6 6 6" />
  </Svg>
);

export const IconChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="m9.5 6 6 6-6 6" />
  </Svg>
);

export const IconArrowUpRight = (p: P) => (
  <Svg {...p}>
    <path d="M7.5 16.5 16.5 7.5M9 7.5h7.5V15" />
  </Svg>
);

export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Svg>
);

export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

export const IconWallet = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="6" width="17" height="13" rx="2.5" />
    <path d="M3.5 9.5h17" opacity=".5" />
    <circle cx="16.4" cy="14.2" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
  </Svg>
);

export const IconSplit = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 12h5" />
    <path d="M8.5 12c3 0 3.6-5 7.5-5h4.5M8.5 12c3 0 3.6 5 7.5 5h4.5" />
  </Svg>
);
