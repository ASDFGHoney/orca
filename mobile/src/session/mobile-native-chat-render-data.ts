import { formatAgentTypeLabel } from '../../../src/shared/agent-type-label'
import {
  formatNativeChatEmptyStateCopy,
  type NativeChatEmptyStateCopy
} from '../../../src/shared/native-chat-empty-state'
import { stripNoiseMessages } from '../../../src/shared/native-chat-noise'
import { foldToolMessages } from '../../../src/shared/native-chat-tool-fold'
import { isImageRefBlock, type NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  normalizeImageTranscriptMessages,
  stripImagePromptMarkersFromTextBlocks
} from './mobile-native-chat-image-transcript-markers'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'

/** The centered empty-state copy for a chat with no messages, mirroring the
 *  desktop `NativeChatEmptyState` (shared copy + agent label) so the two surfaces
 *  stay in lockstep. Returns null when the list should stay bare (idle, or the
 *  loading spinner owns the view). */
export function mobileNativeChatEmptyState(
  status: MobileNativeChatStatus,
  agent: string | null,
  error?: string
): NativeChatEmptyStateCopy | null {
  const agentLabel = agent ? formatAgentTypeLabel(agent) : 'the agent'
  switch (status) {
    // A live agent with no transcript yet — and a loaded-but-empty transcript —
    // are both "start a chat"; invite the first message instead of implying the
    // agent is still starting up.
    case 'waiting-session':
    case 'ready':
      return formatNativeChatEmptyStateCopy('empty', agentLabel)
    case 'error': {
      const copy = formatNativeChatEmptyStateCopy('error', agentLabel)
      return error ? { ...copy, subtitle: error } : copy
    }
    default:
      return null
  }
}

/** An optimistic user echo: the text and/or the local preview URIs of any images
 *  ridden along on the send, shown until the transcript catches up. */
export type MobileNativeChatPendingItem = {
  id: string
  text: string
  images?: string[]
}

export function foldMobileNativeChatMessages(
  messages: NativeChatMessage[],
  windowHeadMessageId?: string
): NativeChatMessage[] {
  // Normalize first (desktop assembler parity): image marker turns fold into
  // image-ref blocks instead of rendering as raw `[Image: …]` text.
  return foldToolMessages(
    stripNoiseMessages(normalizeImageTranscriptMessages(messages, { windowHeadMessageId }))
  )
}

/** Assemble the list data the chat renders: the folded transcript, then a
 *  synthetic bubble for the streaming text the gate let through, then the
 *  route-owned accepted optimistic messages at the tail. */
export function buildMobileNativeChatTransientData({
  folded,
  streaming,
  pending,
  imagePreviewsByMessageId
}: {
  folded: NativeChatMessage[]
  /** Streaming bubble text, already gated by `deriveMobileNativeChatStreaming`. */
  streaming: string | null
  pending: MobileNativeChatPendingItem[]
  imagePreviewsByMessageId?: Record<string, string[]>
}): { folded: NativeChatMessage[]; streaming: string | null; data: NativeChatMessage[] } {
  const renderedFolded = folded.map((message) => {
    const previews = imagePreviewsByMessageId?.[message.id]
    if (message.role !== 'user' || !previews?.length) {
      return message
    }
    let previewIndex = 0
    const blocks = message.blocks.map((block) => {
      if (!isImageRefBlock(block)) {
        return block
      }
      const url = previews[previewIndex]
      previewIndex += 1
      return url ? { ...block, url } : block
    })
    while (previewIndex < previews.length) {
      blocks.push({ type: 'image-ref', url: previews[previewIndex] })
      previewIndex += 1
    }
    // Why: a bound preview is positive proof this turn echoes an image sent from
    // this device (`findLandedImagePreviewEchoes` binds it to nothing else), so
    // its markers are placeholders — no visible source run needed to vouch for
    // them. Without this a marker-only host echo captions the user's own photo
    // with a literal `[Image #1]`.
    //
    // Budget counts ONLY path-less blocks — the previews appended just above. A
    // block with a path came from a real `[Image: source: …]` turn, so the fold
    // already spent that marker; charging for it again would re-strip a surplus
    // marker the fold deliberately preserved as the user's own words.
    const unvouchedImages = blocks.filter((block) => isImageRefBlock(block) && !block.path).length
    return { ...message, blocks: stripImagePromptMarkersFromTextBlocks(blocks, unvouchedImages) }
  })
  const data: NativeChatMessage[] = [
    ...renderedFolded,
    ...(streaming
      ? [
          {
            id: 'streaming',
            role: 'assistant' as const,
            blocks: [{ type: 'text' as const, text: streaming }],
            timestamp: null,
            source: 'hook' as const
          }
        ]
      : []),
    ...pending.map((p) => ({
      id: p.id,
      role: 'user' as const,
      // Text first (when present), then a thumbnail per ridden-along image so the
      // sent photo shows immediately, before the transcript echo lands.
      blocks: [
        ...(p.text ? [{ type: 'text' as const, text: p.text }] : []),
        ...(p.images ?? []).map((uri) => ({ type: 'image-ref' as const, url: uri }))
      ],
      timestamp: null,
      source: 'transcript' as const
    }))
  ]
  return { folded: renderedFolded, streaming, data }
}
