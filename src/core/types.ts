import { z } from "zod"

export const messageSchema = z.object({
  id: z.string().min(1).max(240),
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string().max(1_000_000),
})

export const observationSchema = z.object({
  host: z.enum(["opencode", "codex", "claude-code", "mcp", "cli"]),
  sessionId: z.string().min(1).max(240),
  turnId: z.string().min(1).max(240),
  step: z.number().int().min(0).max(10_000_000),
  messages: z
    .array(messageSchema)
    .max(500)
    .refine(
      (messages) => new Set(messages.map((message) => message.id)).size === messages.length,
      "Message IDs must be unique",
    ),
})

export const findingSchema = z
  .object({
    kind: z.enum(["heads_up", "explainer"]),
    topic: z.string().trim().min(3).max(100),
    summary: z.string().trim().min(10).max(240),
    explanation: z.string().trim().min(20).max(1_600),
    confidence: z.number().min(0).max(1),
    evidence: z
      .array(
        z.object({
          messageId: z.string().min(1).max(240),
          quote: z.string().trim().min(4).max(360),
        }),
      )
      .min(1)
      .max(3),
  })
  .strict()

export const responseSchema = z.object({ note: findingSchema.nullable() }).strict()
export const feedbackSchema = z.enum(["known", "dismissed", "helpful", "irrelevant"])
export const noteSchema = findingSchema.extend({
  id: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  host: observationSchema.shape.host,
  createdAt: z.number(),
  deliveredAt: z.number().optional(),
  status: z.enum(["unread", "known", "dismissed", "helpful", "irrelevant", "expired"]),
})

export type ContextMessage = z.infer<typeof messageSchema>
export type Observation = z.infer<typeof observationSchema>
export type Finding = z.infer<typeof findingSchema>
export type Note = z.infer<typeof noteSchema>
export type Feedback = z.infer<typeof feedbackSchema>

export interface ModelRequest {
  system: string
  prompt: string
  schema: Record<string, unknown>
  signal: AbortSignal
  maxOutputTokens: number
}

export interface ModelResponse {
  text: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

export interface ModelProvider {
  readonly name: string
  complete(request: ModelRequest): Promise<ModelResponse>
}

export type ObservationResult =
  | { status: "shown"; note: Note }
  | { status: "quiet"; reason: "no_finding" | "unsubstantiated" | "duplicate" | "low_confidence" }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: "provider_error" | "invalid_response" | "timeout" | "cancelled" }
