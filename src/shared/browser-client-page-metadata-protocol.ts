import { z } from 'zod'

const Identity = z.string().min(1).max(256)
const Generation = z.number().int().min(1).max(0xffff_ffff)

export const BrowserClientPageMetadataParams = z.object({
  browserHostClientId: Identity,
  browserHostGeneration: Generation,
  browserPageId: Identity,
  pageHostGeneration: Generation,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  url: z.string().max(8192),
  title: z.string().max(4096),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean()
})

export type BrowserClientPageMetadataParams = z.infer<typeof BrowserClientPageMetadataParams>

export const BrowserClientPageMetadataAck = z.object({ accepted: z.boolean() })
export type BrowserClientPageMetadataAck = z.infer<typeof BrowserClientPageMetadataAck>
