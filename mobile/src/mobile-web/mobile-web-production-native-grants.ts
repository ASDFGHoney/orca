import type { MobileWebBridgeShellMessage } from '../../../src/shared/mobile-web/bridge-contract'
import { MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES } from '../../../src/shared/mobile-web/bridge-limits'

type MobileWebNativeOperationGrant = Extract<
  MobileWebBridgeShellMessage,
  { type: 'init' }
>['grants'][number]

export const MOBILE_WEB_PRODUCTION_NATIVE_GRANTS = [
  {
    capability: 'native',
    operation: 'alert',
    limits: {
      maxRequestBytes: 32 * 1024,
      maxResponseBytes: 256,
      maxConcurrent: 1,
      rateCapacity: 4,
      rateRefillPerSecond: 1
    }
  },
  {
    capability: 'native',
    operation: 'clipboardAvailability',
    limits: {
      maxRequestBytes: 256,
      maxResponseBytes: 256,
      maxConcurrent: 1,
      rateCapacity: 8,
      rateRefillPerSecond: 2
    }
  },
  {
    capability: 'native',
    operation: 'hapticSelection',
    limits: {
      maxRequestBytes: 256,
      maxResponseBytes: 256,
      maxConcurrent: 1,
      rateCapacity: 12,
      rateRefillPerSecond: 8
    }
  },
  {
    capability: 'native',
    operation: 'hapticFeedback',
    limits: {
      maxRequestBytes: 256,
      maxResponseBytes: 256,
      maxConcurrent: 1,
      rateCapacity: 16,
      rateRefillPerSecond: 8
    }
  },
  {
    capability: 'native',
    operation: 'clipboardWrite',
    limits: {
      maxRequestBytes: MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES,
      maxResponseBytes: 256,
      maxConcurrent: 1,
      rateCapacity: 4,
      rateRefillPerSecond: 1
    }
  },
  {
    capability: 'native',
    operation: 'openExternal',
    limits: {
      maxRequestBytes: 8192,
      maxResponseBytes: 256,
      maxConcurrent: 1,
      rateCapacity: 6,
      rateRefillPerSecond: 2
    }
  },
  {
    capability: 'native',
    operation: 'terminalPreferences',
    limits: {
      maxRequestBytes: 256,
      maxResponseBytes: 1024,
      maxConcurrent: 1,
      rateCapacity: 8,
      rateRefillPerSecond: 2
    }
  },
  {
    capability: 'native',
    operation: 'terminalAccessoryPreferences',
    limits: {
      maxRequestBytes: 256,
      maxResponseBytes: 32 * 1024,
      maxConcurrent: 1,
      rateCapacity: 8,
      rateRefillPerSecond: 2
    }
  },
  {
    capability: 'native',
    operation: 'terminalCustomKeysUpdate',
    limits: {
      maxRequestBytes: 32 * 1024,
      maxResponseBytes: 256,
      maxConcurrent: 1,
      rateCapacity: 8,
      rateRefillPerSecond: 2
    }
  },
  {
    capability: 'native',
    operation: 'terminalTextScaleUpdate',
    limits: {
      maxRequestBytes: 256,
      maxResponseBytes: 256,
      maxConcurrent: 1,
      rateCapacity: 8,
      rateRefillPerSecond: 2
    }
  },
  {
    capability: 'native',
    operation: 'sessionChatDraftRead',
    limits: {
      maxRequestBytes: 2048,
      maxResponseBytes: 8192,
      maxConcurrent: 2,
      rateCapacity: 12,
      rateRefillPerSecond: 4
    }
  },
  {
    capability: 'native',
    operation: 'sessionChatDraftWrite',
    limits: {
      maxRequestBytes: 8192,
      maxResponseBytes: 256,
      maxConcurrent: 2,
      rateCapacity: 16,
      rateRefillPerSecond: 8
    }
  }
] as const satisfies readonly MobileWebNativeOperationGrant[]
