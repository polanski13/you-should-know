import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export class JsonLineClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >()
  private readonly listeners = new Set<(method: string, params: unknown) => void>()
  private sequence = 0
  private buffer = ""
  private failure?: Error
  private readonly abort: () => void

  constructor(
    command: string,
    args: string[],
    options: { cwd: string; signal: AbortSignal; env?: NodeJS.ProcessEnv },
  ) {
    options.signal.throwIfAborted()
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, YSK_OBSERVER: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk))
    this.child.stderr.resume()
    this.child.on("error", () =>
      this.fail(new Error("Could not start Codex. Check its executable and installation.")),
    )
    this.child.on("close", () =>
      this.fail(new Error("Codex app-server closed before completing the request")),
    )
    this.child.stdin.on("error", () => this.fail(new Error("Codex app-server input closed")))
    this.abort = () => {
      this.fail(new Error("Codex request cancelled"))
      this.close()
    }
    options.signal.addEventListener("abort", this.abort, { once: true })
    this.child.once("close", () => options.signal.removeEventListener("abort", this.abort))
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) })
  }

  subscribe(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    this.fail(new Error("Codex connection closed"))
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.stdin.end()
    this.child.kill("SIGTERM")
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 1_000)
    timer.unref()
    this.child.once("close", () => clearTimeout(timer))
  }

  private write(value: unknown): void {
    if (this.failure) return
    this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > 2_000_000) {
      this.fail(new Error("Codex protocol frame exceeds its size limit"))
      this.close()
      return
    }
    let boundary: number
    while ((boundary = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, boundary).trim()
      this.buffer = this.buffer.slice(boundary + 1)
      if (!line) continue
      let message: Record<string, unknown>
      try {
        message = object(JSON.parse(line))
      } catch {
        this.fail(new Error("Invalid JSON from Codex app-server"))
        this.close()
        return
      }
      if (typeof message.method === "string") {
        if (message.id !== undefined) {
          this.write({
            id: message.id,
            error: {
              code: -32601,
              message: "The observer cannot perform actions or request permissions",
            },
          })
          this.fail(new Error("Codex requested an action in an observation-only thread"))
          this.close()
          return
        }
        for (const listener of this.listeners) listener(message.method, message.params)
      } else if (typeof message.id === "number") {
        const pending = this.pending.get(message.id)
        if (!pending) continue
        this.pending.delete(message.id)
        if (message.error)
          pending.reject(
            new Error(
              `Codex app-server rejected request (${String(object(message.error).code ?? "unknown")})`,
            ),
          )
        else pending.resolve(message.result)
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const listener of this.listeners) listener("ysk/closed", undefined)
  }
}
