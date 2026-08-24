import type {
  PtyInputInvalidationReason,
  PtyInputTransaction,
  PtyInputWriteResult
} from './pty-input-transaction'
export type GenerationToken = { generation: number | null; active: boolean }
export type TransactionToken = GenerationToken & {
  reason: PtyInputInvalidationReason | null
  invalidate: (reason: PtyInputInvalidationReason) => void
}
export type OwnedTokenState<T extends GenerationToken> = {
  tokens: Set<T>
  pasteOpen: boolean
  pasteMutationPending: boolean
  pendingQueryReplies: string[]
  pendingQueryReplyCodeUnits: number
}
export function invalidateLazyGenerations<T extends GenerationToken, R extends string>(
  lazyByPtyId: Map<string, Set<T>>,
  ptyId: string,
  generation: number,
  except: T | undefined,
  invalidate: (token: T, reason: R) => void,
  reason: R
): void {
  for (const token of lazyByPtyId.get(ptyId) ?? []) {
    if (token !== except && token.generation !== null && token.generation !== generation) {
      invalidate(token, reason)
    }
  }
  pruneLazyTokens(lazyByPtyId, ptyId)
}
export function pruneLazyTokens<T extends GenerationToken>(
  lazyByPtyId: Map<string, Set<T>>,
  ptyId: string
): void {
  const lazy = lazyByPtyId.get(ptyId)
  if (!lazy) {
    return
  }
  for (const token of lazy) {
    if (!token.active) {
      lazy.delete(token)
    }
  }
  if (lazy.size === 0) {
    lazyByPtyId.delete(ptyId)
  }
}
export function releaseLazyToken<T extends GenerationToken>(
  lazyByPtyId: Map<string, Set<T>>,
  ptyId: string,
  token: T,
  deactivate: boolean
): void {
  const lazy = lazyByPtyId.get(ptyId)
  lazy?.delete(token)
  if (lazy?.size === 0) {
    lazyByPtyId.delete(ptyId)
  }
  if (deactivate) {
    token.active = false
  }
}
export function releaseOwnerToken<T extends GenerationToken>(
  ownerByPtyId: Map<string, OwnedTokenState<T>>,
  ptyId: string,
  owner: OwnedTokenState<T>,
  token: T,
  flush: (owner: OwnedTokenState<T>) => boolean
): void {
  if (ownerByPtyId.get(ptyId) !== owner || !owner.tokens.delete(token)) {
    return
  }
  token.active = false
  if (owner.tokens.size > 0 || owner.pasteOpen || owner.pasteMutationPending) {
    return
  }
  if (flush(owner)) {
    ownerByPtyId.delete(ptyId)
  }
}
export function invalidateOwner<T extends GenerationToken, R extends string>(
  ownerByPtyId: Map<string, OwnedTokenState<T>>,
  ptyId: string,
  owner: OwnedTokenState<T>,
  reason: R,
  invalidate: (token: T, reason: R) => void
): void {
  if (ownerByPtyId.get(ptyId) !== owner) {
    return
  }
  ownerByPtyId.delete(ptyId)
  for (const token of owner.tokens) {
    invalidate(token, reason)
  }
  owner.tokens.clear()
}
export function createTransactionToken(generation: number | null): TransactionToken {
  return { generation, active: true, reason: null, invalidate: () => undefined }
}
export function transactionForToken(
  token: TransactionToken,
  operations: { write: (data: string) => PtyInputWriteResult; release: () => void }
): PtyInputTransaction {
  return {
    write: operations.write,
    invalidated: new Promise<PtyInputInvalidationReason>((resolve) => {
      token.invalidate = resolve
    }),
    get active() {
      return token.active
    },
    get invalidationReason() {
      return token.reason
    },
    release: operations.release
  }
}
