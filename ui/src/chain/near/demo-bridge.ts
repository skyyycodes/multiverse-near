// The demo wallet used by the walkthrough recorder and the end-to-end tests. It exists only when the page was opened
// by one of them: they expose `window.__nearDemo(method, paramsJson)` (Playwright's exposeFunction), which signs with
// test keys outside the browser. The app wraps that function as a NEAR Connect injected wallet, so it appears in the
// normal wallet picker and goes through the same code paths as any real wallet. Real users never have the function.

export const DEMO_WALLET_ID = "multiverse-demo";

type DemoFn = (method: string, paramsJson: string) => Promise<unknown> | unknown;

declare global {
  interface Window {
    __nearDemo?: DemoFn;
    /** Set by the recorder to connect the demo wallet without opening the picker. */
    __nearDemoAutoConnect?: boolean;
  }
}

export const hasDemoBridge = () => typeof window !== "undefined" && typeof window.__nearDemo === "function";
export const wantsAutoConnect = () => hasDemoBridge() && window.__nearDemoAutoConnect === true;

async function call(method: string, params: unknown): Promise<unknown> {
  const fn = window.__nearDemo;
  if (!fn) throw new Error("The demo wallet is not available on this page.");
  const r = await fn(method, JSON.stringify(params ?? {}, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  if (typeof r !== "string") return r;
  if (r === "") return undefined;
  try {
    return JSON.parse(r) as unknown;
  } catch {
    return r;
  }
}

const unsupported = (what: string) => () => Promise.reject(new Error(`The demo wallet does not support ${what}.`));

/** A NEAR Connect `NearWalletBase` whose every method is answered by `window.__nearDemo`. */
export function createDemoWallet(network: "testnet" | "mainnet") {
  return {
    manifest: {
      id: DEMO_WALLET_ID,
      name: "Demo wallet (test keys)",
      type: "injected" as const,
      version: "1.0.0",
      description: "Signs with test keys held by the demo recorder. Not a real wallet.",
      icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23050A24'/%3E%3Crect x='7' y='7' width='8' height='8' rx='2' fill='%235EE6F0'/%3E%3Crect x='17' y='7' width='8' height='8' rx='2' fill='%233D7BFF'/%3E%3Crect x='7' y='17' width='8' height='8' rx='2' fill='%238B7CFF'/%3E%3Crect x='17' y='17' width='8' height='8' rx='2' fill='%23C34BFF'/%3E%3C/svg%3E",
      website: "https://github.com/",
      executor: "",
      platform: [],
      permissions: {},
      features: {
        signMessage: true,
        signTransaction: false,
        signAndSendTransaction: true,
        signAndSendTransactions: true,
        signInWithoutAddKey: true,
        signInAndSignMessage: false,
        signInWithFunctionCallKey: false,
        signDelegateActions: false,
        mainnet: network === "mainnet",
        testnet: network === "testnet",
      },
    },
    signIn: (p?: unknown) => call("signIn", p),
    signInAndSignMessage: unsupported("signing a message at sign-in"),
    signOut: (p?: unknown) => call("signOut", p),
    getAccounts: (p?: unknown) => call("getAccounts", p),
    signAndSendTransaction: (p: unknown) => call("signAndSendTransaction", p),
    signAndSendTransactions: (p: unknown) => call("signAndSendTransactions", p),
    signMessage: (p: { nonce?: Uint8Array } & Record<string, unknown>) =>
      call("signMessage", { ...p, nonce: p.nonce ? Array.from(p.nonce) : undefined }),
    signDelegateActions: unsupported("delegate actions"),
  };
}

export function injectDemoWallet(network: "testnet" | "mainnet") {
  window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: createDemoWallet(network) }));
}
