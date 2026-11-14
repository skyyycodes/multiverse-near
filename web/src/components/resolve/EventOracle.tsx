"use client";

import { TxButton } from "@/components/ui/TxButton";
import { CONTRACT_ID } from "@/lib/data/client";
import type { EventState } from "@/lib/domain";
import { useEventMeta, useOutLayerConfig, useOutLayerDates } from "@/lib/hooks/useProposal";
import { useSubmit } from "@/lib/hooks/useTx";
import { GAS_MAX, requestResolution } from "@/lib/near/tx";
import { nearText } from "@/lib/proposals";

/**
 * Under an event card (web 6.7): the event's public data source (`event_meta`), and for a FRED question the OutLayer
 * request (T43) that reads the real result inside a TEE. Anyone may send it; OutLayer refunds what it does not use.
 */
export function EventOracle({ event: e }: { event: EventState }) {
  const meta = useEventMeta(e.id);
  const dates = useOutLayerDates(e.id, !e.finalized);
  const cfg = useOutLayerConfig();
  const submit = useSubmit();
  const source = meta.data?.source;
  const d = dates.data;
  const deposit = cfg.data?.deposit;
  return (
    <>
      {source && (
        <p className="text-[12px] leading-relaxed break-words text-mute" data-demo="event-source">
          Data source:{" "}
          {/^https?:\/\//.test(source) ? (
            <a href={source} target="_blank" rel="noreferrer" className="text-cobalt-ink underline-offset-2 hover:underline">
              {source}
            </a>
          ) : (
            source
          )}
        </p>
      )}
      {d && !e.finalized && (
        <div className="flex flex-col gap-2 border-t border-line pt-3.5" data-demo="outlayer-box">
          {d.pending ? (
            <p className="text-[13px] text-ink" data-demo="outlayer-pending">
              OutLayer is reading FRED (request #{d.request})…
            </p>
          ) : (
            <>
              <TxButton
                demo="request-resolution"
                action="request_resolution"
                size="md"
                tone="secondary"
                label="Ask OutLayer to read FRED"
                busyLabel="Sending the request…"
                blocker={
                  e.proposalOpen ? "A result is already proposed" : !cfg.data ? (cfg.isPending ? "Reading the OutLayer setup…" : "OutLayer is not configured") : undefined
                }
                gas={GAS_MAX}
                deposit={deposit ?? 0n}
                run={() => submit(requestResolution(CONTRACT_ID, e.id, deposit!))}
              />
              {deposit !== undefined && (
                <p className="text-[12px] text-mute">
                  {nearText(deposit)} NEAR; OutLayer refunds what it does not use. FRED rates for {d.before} and {d.after} decide it.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
