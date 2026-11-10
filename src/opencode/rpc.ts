import type { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { feedbackSchema, noteSchema } from "../core/types.js"

export const YouShouldKnow = {
  id: "you-should-know",
  methods: {
    notes: { input: z.object({ sessionId: z.string().optional() }), output: z.array(noteSchema) },
    feedback: { input: z.object({ id: z.string(), feedback: feedbackSchema }), output: noteSchema },
    pause: { input: z.object({ paused: z.boolean() }), output: z.boolean() },
  },
  events: {
    changed: { schema: z.object({ sessionId: z.string() }) },
  },
} satisfies Rpc.PortableDefinition
