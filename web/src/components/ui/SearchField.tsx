"use client";

/** A search box with a magnifier and a clear button (`<demo>-clear`). */
export function SearchField({ value, onChange, placeholder = "Search", demo }: { value: string; onChange: (v: string) => void; placeholder?: string; demo?: string }) {
  return (
    <div className="flex h-11 min-w-0 items-center gap-2 rounded-full border border-line-strong bg-sheet pr-1.5 pl-3.5 focus-within:border-ink">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0 text-mute">
        <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
        <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete="off"
        data-demo={demo}
        className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          data-demo={demo ? `${demo}-clear` : undefined}
          className="focus-ring grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-tile hover:text-ink"
        >
          ✕
        </button>
      )}
    </div>
  );
}
