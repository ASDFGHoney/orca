import { describe, expect, it } from 'vitest'
import {
  AI_VAULT_SCAN_CANCELLED_MESSAGE,
  isAiVaultScanCancelledError
} from '../shared/ai-vault-types'
import { relayAiVaultServiceErrorMessage } from './ai-vault-service-protocol'

describe('relay AI Vault service protocol', () => {
  it('translates shared Cursor cancellation at the IPC boundary', () => {
    const message = relayAiVaultServiceErrorMessage(new Error('cursor_sidecar_scan_cancelled'))

    expect(message).toBe(AI_VAULT_SCAN_CANCELLED_MESSAGE)
    expect(isAiVaultScanCancelledError(new Error(message))).toBe(true)
  })
})
