// The toasts of real transactions: an action announces itself as pending, then becomes done (with its explorer link)
// or failed (with the contract's error in plain words). The shell's Toaster renders them in the site's style.

export type ToastKind = "trade" | "loan" | "lend" | "resolve" | "wallet" | "other";
export type TxToast = {
  id: number;
  kind: ToastKind;
  state: "pending" | "done" | "failed";
  title: string;
  text: string;
  /** The transaction on the explorer, once it landed. */
  href?: string;
  /** The market the action was about, for "View market". */
  market?: number;
};

type Listener = (t: TxToast) => void;
const listeners = new Set<Listener>();
let next = 0;

/** Subscribe to every toast change (a new toast, or one that moved on); returns the unsubscribe. */
export function onTxToast(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const emit = (t: TxToast) => listeners.forEach((l) => l(t));

/** Announce a pending action; the returned functions move that same toast to done or failed. */
export function txToast(kind: ToastKind, title: string, text: string, market?: number) {
  const id = ++next;
  emit({ id, kind, state: "pending", title, text, market });
  return {
    step: (line: string) => emit({ id, kind, state: "pending", title, text: line, market }),
    done: (line: string, href?: string) => emit({ id, kind, state: "done", title, text: line, href, market }),
    failed: (line: string) => emit({ id, kind, state: "failed", title, text: line, market }),
  };
}
