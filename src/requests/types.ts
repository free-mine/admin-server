import type { z } from 'zod'
import type { actionSchema, previewRequestSchema } from './schemas.js'
export type Action = z.infer<typeof actionSchema>
export type PreviewRequest = z.infer<typeof previewRequestSchema>
export type Params<K extends Action['kind']> = Extract<Action, { kind: K }>['params']
