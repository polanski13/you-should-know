import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import lockfile from "proper-lockfile"
import { z } from "zod"
import { isErrno } from "./config.js"
import { digest } from "./context.js"
import { noteSchema } from "./types.js"

const sessionSchema = z.object({
  turnId: z.string(),
  touchedAt: z.number(),
  checks: z.number().int().nonnegative().default(0),
  lastCheckAt: z.number().default(0),
  revision: z.string().default(""),
  offeredTurn: z.string().optional(),
  noteId: z.string().optional(),
  ignored: z.number().int().nonnegative().default(0),
  skip: z.number().int().nonnegative().default(0),
  lease: z.object({ id: z.string(), until: z.number() }).optional(),
})

export const stateSchema = z.object({
  version: z.literal(1),
  notes: z.array(noteSchema),
  known: z.array(z.object({ topic: z.string(), at: z.number() })),
  sessions: z.record(z.string(), sessionSchema),
  checks: z.array(z.number()),
  paused: z.boolean(),
})

export type State = z.infer<typeof stateSchema>
export type SessionState = z.infer<typeof sessionSchema>

export const emptyState = (): State => ({
  version: 1,
  notes: [],
  known: [],
  sessions: {},
  checks: [],
  paused: false,
})

export interface StateStore {
  transact<T>(fn: (state: State) => T | Promise<T>): Promise<T>
}

export class FileStore implements StateStore {
  private constructor(
    readonly directory: string,
    private readonly path: string,
  ) {}

  static async create(root: string, workspace: string): Promise<FileStore> {
    const canonical = await realpath(workspace).catch(() => resolve(workspace))
    const directory = join(root, "projects", digest(canonical).slice(0, 24))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return new FileStore(directory, join(directory, "state.json"))
  }

  async transact<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
    const guard = join(this.directory, "write")
    const handle = await open(guard, "a", 0o600)
    await handle.close()
    const release = await lockfile.lock(guard, {
      stale: 30_000,
      retries: { retries: 25, minTimeout: 20, maxTimeout: 200, randomize: true },
    })
    try {
      let state: State
      try {
        const content = await readFile(this.path, "utf8")
        if (content.length > 4_000_000) throw new Error("State file exceeds its size limit")
        state = stateSchema.parse(JSON.parse(content))
      } catch (error) {
        if (!isErrno(error, "ENOENT"))
          throw new Error("Cannot read observer state; the existing file was preserved", {
            cause: error,
          })
        state = emptyState()
      }
      const before = JSON.stringify(state)
      const result = await fn(state)
      if (JSON.stringify(state) === before) return result
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        const file = await open(temporary, "wx", 0o600)
        try {
          await file.writeFile(`${JSON.stringify(state)}\n`, "utf8")
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(temporary, this.path)
      } finally {
        await rm(temporary, { force: true })
      }
      return result
    } finally {
      await release()
    }
  }
}

export function prune(state: State, now: number, retentionDays: number): void {
  const cutoff = now - retentionDays * 86_400_000
  state.notes = state.notes.filter((note) => note.createdAt >= cutoff).slice(-100)
  state.known = state.known.filter((topic) => topic.at >= cutoff).slice(-100)
  state.checks = state.checks.filter((time) => time > now - 3_600_000)
  state.sessions = Object.fromEntries(
    Object.entries(state.sessions)
      .filter(([, session]) => session.touchedAt >= cutoff)
      .sort(([, a], [, b]) => b.touchedAt - a.touchedAt)
      .slice(0, 64),
  )
}
