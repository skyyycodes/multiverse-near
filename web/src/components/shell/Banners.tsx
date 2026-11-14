"use client";

import { PauseBanner } from "./PauseBanner";
import { NewerContractBanner, UpdateBanner } from "./UpdateBanner";

/**
 * The shell's notices: maintenance pause, a newer contract, a newer web. Desktop renders them in a band under the top
 * bar; the phone renders them compact inside each screen's header. Nothing renders when there is nothing to say.
 */
export function Banners({ compact }: { compact?: boolean }) {
  return (
    <div className={`flex flex-col gap-2 empty:hidden ${compact ? "" : "mx-auto max-w-[1240px] px-6 pt-2 xl:px-8"}`}>
      <PauseBanner compact={compact} />
      <NewerContractBanner compact={compact} />
      <UpdateBanner compact={compact} />
    </div>
  );
}
