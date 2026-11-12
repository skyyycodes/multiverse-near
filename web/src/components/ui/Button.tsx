import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type Tone = "primary" | "secondary" | "light" | "ghost";

const TONES: Record<Tone, string> = {
  // ink pill on white sheets
  primary: "bg-ink text-white hover:bg-[#1a2238] disabled:bg-ink/35 disabled:text-white/90",
  // outlined pill on white sheets
  secondary: "border border-line-strong bg-sheet text-ink hover:border-ink/40 disabled:text-mute disabled:hover:border-line-strong",
  // white pill on dark headers
  light: "bg-white text-ink hover:bg-ice disabled:bg-white/50",
  ghost: "text-ink hover:bg-tile disabled:text-mute",
};

export function pillClass(tone: Tone = "primary", size: "lg" | "md" | "sm" = "lg") {
  const sizes = { lg: "min-h-[52px] px-6 text-[15px]", md: "min-h-11 px-5 text-sm", sm: "min-h-9 px-3.5 text-[13px]" };
  return `focus-ring inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors duration-150 disabled:cursor-not-allowed ${sizes[size]} ${TONES[tone]}`;
}

export function Pill({
  tone = "primary",
  size = "lg",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; size?: "lg" | "md" | "sm" }) {
  return <button type="button" className={`${pillClass(tone, size)} ${className}`} {...rest} />;
}

export function PillLink({
  href,
  tone = "primary",
  size = "md",
  className = "",
  children,
  demo,
}: {
  href: string;
  tone?: Tone;
  size?: "lg" | "md" | "sm";
  className?: string;
  children: ReactNode;
  demo?: string;
}) {
  return (
    <Link href={href} data-demo={demo} className={`${pillClass(tone, size)} ${className}`}>
      {children}
    </Link>
  );
}

/** A small text button inside a label row ("wallet: 2,000.00 wNEAR", "max $3,600.00"). */
export function InlineButton({ className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`focus-ring num -my-1 rounded-md px-1.5 py-1 text-[12px] text-cobalt-ink hover:bg-tile hover:text-ink ${className}`}
      {...rest}
    />
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`size-4 animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
