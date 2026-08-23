import { MOBILE_WEB_SESSION_EVENT_MAX_BYTES } from '../../../src/shared/mobile-web/bridge-operation-contract'
import type { MobileWebOperationGrant } from './mobile-web-production-grants'

export const MOBILE_WEB_PRODUCTION_SESSION_GRANTS = [
  {
    capability: 'agentHistory',
    operation: 'snapshot',
    limits: {
      maxRequestBytes: 2048,
      maxResponseBytes: 384 * 1024,
      maxConcurrent: 1,
      rateCapacity: 8,
      rateRefillPerSecond: 2
    }
  },
  {
    capability: 'agentHistory',
    operation: 'preview',
    limits: {
      maxRequestBytes: 512,
      maxResponseBytes: 24 * 1024,
      maxConcurrent: 4,
      rateCapacity: 12,
      rateRefillPerSecond: 4
    }
  },
  {
    capability: 'agentHistory',
    operation: 'resume',
    limits: {
      maxRequestBytes: 1024,
      maxResponseBytes: 2048,
      maxConcurrent: 1,
      rateCapacity: 3,
      rateRefillPerSecond: 0.25
    }
  },
  {
    capability: 'session',
    operation: 'capabilities',
    limits: {
      maxRequestBytes: 256,
      maxResponseBytes: 16 * 1024,
      maxConcurrent: 1,
      rateCapacity: 4,
      rateRefillPerSecond: 1
    }
  },
  {
    capability: 'session',
    operation: 'snapshot',
    limits: {
      maxRequestBytes: 1024,
      maxResponseBytes: MOBILE_WEB_SESSION_EVENT_MAX_BYTES,
      maxConcurrent: 2,
      rateCapacity: 6,
      rateRefillPerSecond: 2
    }
  },
  {
    capability: 'session',
    operation: 'subscribe',
    limits: {
      maxRequestBytes: 1024,
      maxResponseBytes: MOBILE_WEB_SESSION_EVENT_MAX_BYTES,
      maxConcurrent: 2,
      rateCapacity: 4,
      rateRefillPerSecond: 1
    }
  },
  {
    capability: 'session',
    operation: 'activate',
    limits: {
      maxRequestBytes: 2048,
      maxResponseBytes: MOBILE_WEB_SESSION_EVENT_MAX_BYTES,
      maxConcurrent: 1,
      rateCapacity: 12,
      rateRefillPerSecond: 6
    }
  },
  {
    capability: 'session',
    operation: 'create',
    limits: {
      maxRequestBytes: 1024,
      maxResponseBytes: 1024,
      maxConcurrent: 1,
      rateCapacity: 4,
      rateRefillPerSecond: 1
    }
  },
  {
    capability: 'session',
    operation: 'agentOptions',
    limits: {
      maxRequestBytes: 1024,
      maxResponseBytes: 2048,
      maxConcurrent: 1,
      rateCapacity: 4,
      rateRefillPerSecond: 1
    }
  },
  {
    capability: 'session',
    operation: 'quickCommands',
    limits: {
      maxRequestBytes: 1024,
      maxResponseBytes: 256 * 1024,
      maxConcurrent: 1,
      rateCapacity: 4,
      rateRefillPerSecond: 1
    }
  },
  {
    capability: 'session',
    operation: 'quickCommandMutate',
    limits: {
      maxRequestBytes: 8192,
      maxResponseBytes: 256 * 1024,
      maxConcurrent: 1,
      rateCapacity: 8,
      rateRefillPerSecond: 2
    }
  },
  {
    capability: 'session',
    operation: 'createAgent',
    limits: {
      maxRequestBytes: 2048,
      maxResponseBytes: 1024,
      maxConcurrent: 1,
      rateCapacity: 4,
      rateRefillPerSecond: 1
    }
  },
  {
    capability: 'session',
    operation: 'createQuickCommand',
    limits: {
      maxRequestBytes: 2048,
      maxResponseBytes: 8192,
      maxConcurrent: 1,
      rateCapacity: 4,
      rateRefillPerSecond: 1
    }
  },
  {
    capability: 'session',
    operation: 'createBrowser',
    limits: {
      maxRequestBytes: 8192,
      maxResponseBytes: 1024,
      maxConcurrent: 1,
      rateCapacity: 4,
      rateRefillPerSecond: 1
    }
  },
  {
    capability: 'session',
    operation: 'close',
    limits: {
      maxRequestBytes: 2048,
      maxResponseBytes: 1024,
      maxConcurrent: 1,
      rateCapacity: 8,
      rateRefillPerSecond: 2
    }
  }
] as const satisfies readonly MobileWebOperationGrant[]
