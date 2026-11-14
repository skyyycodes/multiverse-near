// Append-only JSON Lines logs for the bots and the soak: one object per line, written and fsynced
// before the call returns, so a crash loses at most the line being written. bigint values are
// written as decimal strings. A reader skips a torn last line (a crash mid-write) and refuses a
// malformed line anywhere else.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const replacer = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

/** One JSON line (no newline inside: JSON.stringify escapes them). */
export function toJsonLine(value: unknown): string {
  const text = JSON.stringify(value, replacer);
  if (text === undefined) throw new Error("cannot write undefined as a JSON line");
  return `${text}\n`;
}

export class JsonlWriter {
  readonly path: string;
  private fd: number | null;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "a", 0o644);
  }

  /** Appends one record and fsyncs it. */
  append(value: unknown): void {
    if (this.fd === null) throw new Error(`${this.path} is closed`);
    const buf = Buffer.from(toJsonLine(value), "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(this.fd, buf, off, buf.length - off);
    fsyncSync(this.fd);
  }

  close(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }
}

/** Parses JSONL text: a torn final line is dropped (reported in `torn`), any other bad line throws. */
export function parseJsonl<T = unknown>(text: string, path = "jsonl"): { records: T[]; torn: boolean } {
  const lines = text.split("\n");
  const last = lines.pop() ?? "";
  const records: T[] = [];
  for (const [i, line] of lines.entries()) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      throw new Error(`${path}:${i + 1}: not a JSON line`);
    }
  }
  // text without a final newline ends in a line that was never finished
  let torn = false;
  if (last.trim() !== "") {
    try {
      records.push(JSON.parse(last) as T);
    } catch {
      torn = true;
    }
  }
  return { records, torn };
}

export function readJsonl<T = unknown>(path: string): { records: T[]; torn: boolean } {
  if (!existsSync(path)) return { records: [], torn: false };
  return parseJsonl<T>(readFileSync(path, "utf8"), path);
}
