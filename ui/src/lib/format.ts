export const pct = (n: number, digits = 0) => `${(n * 100).toFixed(digits)}%`
export const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
export const short = (account: string) => (account.length > 18 ? `${account.slice(0, 8)}…${account.slice(-6)}` : account)
