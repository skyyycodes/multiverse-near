// Design mode only: the fixture wallet signs nothing. A "transaction" succeeds after a short pause and, where it is the
// next step of the demo story, moves the fixtures to the stage that follows, so the screens can be clicked through.
import type { TxOutcome } from "../near/outcome";
import type { Tx } from "../near/tx";
import { STAGES, type Persona, type Stage } from "./golden";
import { fixtureStage, setFixtureStage } from "./session";

function argsOf(tx: Tx): { method: string; args: Record<string, unknown>; msg?: { action?: string; event_id?: number } } {
  const call = tx.actions[0]?.params;
  const args = call?.args ?? {};
  let msg: { action?: string } | undefined;
  if (typeof args.msg === "string" && args.msg) {
    try {
      msg = JSON.parse(args.msg) as { action?: string };
    } catch {
      msg = undefined;
    }
  }
  return { method: call?.methodName ?? "", args, msg };
}

const after = (stage: Stage, from: Stage) => STAGES.indexOf(stage) >= STAGES.indexOf(from);

/** The story stage this transaction leads to, if it is the story's next step. */
export function nextStage(stage: Stage, tx: Tx, persona: Persona | null): Stage | undefined {
  const { method, args, msg } = argsOf(tx);
  const action = msg?.action ?? method;
  if (stage === "seeded" && action === "conditional_sell" && persona === "alice") return "sold";
  if (stage === "sold" && action === "borrow") return "borrowed";
  if (stage === "borrowed" && action === "post_order") return "book";
  if (stage === "book" && action === "lp_deposit") return "lp";
  if (stage === "lp" && action === "conditional_sell" && persona === "owner") return "pushed";
  if (action === "admin_resolve" || action === "finalize") {
    const event = Number(args.event_id);
    if (event === 2 && !after(stage, "fed")) return "fed";
    if (event === 1 && after(stage, "fed")) return "collapsed";
  }
  return undefined;
}

/** A plausible base58 transaction hash. */
function fakeHash(): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  return Array.from({ length: 44 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

export async function fixtureSend(tx: Tx, persona: Persona | null): Promise<TxOutcome> {
  await new Promise((r) => setTimeout(r, 650));
  const next = nextStage(fixtureStage(), tx, persona);
  if (next) setFixtureStage(next);
  const call = tx.actions[0]?.params;
  // ft_transfer_call returns what the receiver used; the fixtures always use all of it.
  const used = call?.methodName === "ft_transfer_call" ? JSON.stringify(String(call.args.amount ?? "0")) : "";
  return {
    status: { SuccessValue: typeof btoa === "function" ? btoa(used) : "" },
    transaction: { hash: fakeHash() },
    receipts_outcome: [],
  };
}
