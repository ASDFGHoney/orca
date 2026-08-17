import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { toast } from 'sonner'
import { runWorktreeDeletesInParallel } from './delete-worktree-flow'
import { prepareActiveWorktreeFocusAfterDelete } from './active-worktree-focus-after-delete'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'
import { getWorkspaceDeleteLineage } from './workspace-delete-lineage'
import { DeleteWorktreeLineageNotice } from './DeleteWorktreeLineageNotice'
import { DeleteWorktreeSkipConfirmOption } from './DeleteWorktreeSkipConfirmOption'
import { DeleteWorktreeDialogFooter } from './DeleteWorktreeDialogFooter'
import { DeleteWorktreeDialogDescription } from './DeleteWorktreeDialogDescription'
import { DeleteWorktreeTargetPreview } from './DeleteWorktreeTargetPreview'
import { DeleteWorktreeWarningPanels } from './DeleteWorktreeWarningPanels'
import { persistDeleteWorktreeConfirmSkipPreference } from './delete-worktree-preference-toast'
import { getDeleteWorktreeDirtyChangeCounts } from './delete-worktree-dirty-change-counts'
import {
  countFolderWorkspaceDeletes,
  getDeleteWorktreeDialogCopy,
  getDeleteWorktreeLineageDialogCopy,
  isFolderWorkspaceDelete as getIsFolderWorkspaceDelete
} from './delete-worktree-dialog-copy'
import { translate } from '@/i18n/i18n'
import {
  toWorktreeRemovalTarget,
  type WorktreeRemovalTarget
} from '../../../../shared/worktree/removal'
import { showWorkspaceListChangedToast } from './stale-workspace-list-toast'
import { useDeleteWorktreeStatusHydration } from './use-delete-worktree-status-hydration'
import { useConfirmedWorktreeDeleteTargets } from './use-confirmed-worktree-delete-targets'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'

const DeleteWorktreeDialog = React.memo(function DeleteWorktreeDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const removeWorktree = useAppStore((s) => s.removeWorktree)
  const clearWorktreeDeleteState = useAppStore((s) => s.clearWorktreeDeleteState)
  const allWorktrees = useAllWorktrees()
  const repos = useAppStore((s) => s.repos)
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)

  const isOpen = activeModal === 'delete-worktree'
  const worktreeId = typeof modalData.worktreeId === 'string' ? modalData.worktreeId : ''
  const worktreeIds = useMemo(
    () =>
      Array.isArray(modalData.worktreeIds)
        ? modalData.worktreeIds.filter((id): id is string => typeof id === 'string')
        : worktreeId
          ? [worktreeId]
          : [],
    [modalData.worktreeIds, worktreeId]
  )
  const { worktreeDeleteIdentities, lineageDeleteIdentities, resolveConfirmedTargets } =
    useConfirmedWorktreeDeleteTargets({
      worktreeIdentityData: modalData.worktreeDeleteIdentities,
      lineageIdentityData: modalData.lineageDeleteIdentities,
      closeModal
    })
  const deleteStateTargets = useMemo(
    () =>
      worktreeDeleteIdentities.length > 0
        ? worktreeDeleteIdentities
        : worktreeIds.map((id) => ({ id, hostId: undefined })),
    [worktreeDeleteIdentities, worktreeIds]
  )
  const onDeleted =
    typeof modalData.onDeleted === 'function'
      ? (modalData.onDeleted as (targets: WorktreeRemovalTarget[]) => void)
      : null
  const forceOnConfirm = modalData.forceOnConfirm !== false
  const worktree = useMemo(() => {
    if (!worktreeId) {
      return null
    }
    const identity = worktreeDeleteIdentities.find((item) => item.id === worktreeId)
    return (
      allWorktrees.find(
        (item) => item.id === worktreeId && (!identity?.hostId || item.hostId === identity.hostId)
      ) ?? null
    )
  }, [allWorktrees, worktreeDeleteIdentities, worktreeId])
  const worktrees = useMemo(() => {
    if (worktreeIds.length === 0) {
      return []
    }
    if (worktreeDeleteIdentities.length > 0) {
      const selected = new Set(
        worktreeDeleteIdentities.map((identity) =>
          composeWorktreeHostIdentity(identity.hostId, identity.id)
        )
      )
      return allWorktrees.filter((item) => selected.has(getWorktreeHostIdentity(item)))
    }
    const selected = new Set(worktreeIds)
    return allWorktrees.filter((item) => selected.has(item.id))
  }, [allWorktrees, worktreeDeleteIdentities, worktreeIds])
  const repoMap = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])
  const isBatchDelete = worktreeIds.length > 1
  const isFolderWorkspaceDelete = !isBatchDelete && getIsFolderWorkspaceDelete(repoMap, worktree)
  const folderWorkspaceDeleteCount = useMemo(
    () => countFolderWorkspaceDeletes(repoMap, worktrees),
    [repoMap, worktrees]
  )
  const deleteCopy = getDeleteWorktreeDialogCopy({
    isBatchDelete,
    worktree,
    worktreeCount: worktrees.length,
    folderWorkspaceDeleteCount,
    isFolderWorkspaceDelete
  })
  const deleteStateByWorktreeId = useAppStore((s) => s.deleteStateByWorktreeId)
  const lineageDelete = useMemo(
    () =>
      !isBatchDelete && worktree
        ? getWorkspaceDeleteLineage(worktree, allWorktrees, worktreeLineageById)
        : { descendants: [], deleteAllTargets: [] },
    [allWorktrees, isBatchDelete, worktree, worktreeLineageById]
  )
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  // Why: the main worktree is the repo's original clone directory — `git worktree remove`
  // always rejects it. We block the delete button upfront so the user doesn't have to
  // discover this limitation via a confusing force-delete dead-end.
  const isMainWorktree = !isBatchDelete && (worktree?.isMainWorktree ?? false)
  const childWorkspaceCount = lineageDelete.descendants.length
  const hasLineageChildren = childWorkspaceCount > 0
  const canDeleteAllLineage =
    !isMainWorktree && !isBatchDelete && lineageDelete.deleteAllTargets.length > 1
  const lineageFolderWorkspaceDeleteCount = useMemo(
    () => countFolderWorkspaceDeletes(repoMap, lineageDelete.deleteAllTargets),
    [lineageDelete.deleteAllTargets, repoMap]
  )
  const lineageDeleteCopy = getDeleteWorktreeLineageDialogCopy({
    childWorkspaceCount,
    deleteTargetCount: lineageDelete.deleteAllTargets.length,
    folderWorkspaceDeleteCount: lineageFolderWorkspaceDeleteCount
  })
  const allowSkipConfirm =
    !isBatchDelete && modalData.allowSkipConfirm !== false && childWorkspaceCount === 0
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const deleteTargets = useMemo(
    () => (canDeleteAllLineage ? lineageDelete.deleteAllTargets : worktrees),
    [canDeleteAllLineage, lineageDelete.deleteAllTargets, worktrees]
  )
  const deleteStates = useMemo(
    () =>
      deleteTargets
        .map((target) => getDeleteStateForWorktreeHost(target, deleteStateByWorktreeId))
        .filter((state): state is NonNullable<typeof state> => state != null),
    [deleteStateByWorktreeId, deleteTargets]
  )
  const deleteState = worktree
    ? getDeleteStateForWorktreeHost(worktree, deleteStateByWorktreeId)
    : undefined
  const isDeleting = deleteStates.some((state) => state.isDeleting)
  const deleteError = !isBatchDelete ? (deleteState?.error ?? null) : null
  const canForceDelete = !isBatchDelete && (deleteState?.canForceDelete ?? false)
  const gitStatusByWorktreeIdentity = useDeleteWorktreeStatusHydration({
    isOpen,
    deleteTargets,
    repoMap
  })
  const dirtyChangeCountsByWorktreeId = useMemo(() => {
    return getDeleteWorktreeDirtyChangeCounts({
      deleteTargets,
      deleteStateByWorktreeId,
      gitStatusByWorktree,
      gitStatusByWorktreeIdentity,
      repoMap
    })
  }, [
    deleteStateByWorktreeId,
    deleteTargets,
    gitStatusByWorktree,
    gitStatusByWorktreeIdentity,
    repoMap
  ])

  if (!isOpen && dontAskAgain) {
    // Why: this checkbox is a one-shot dialog intent; reset it as soon as the
    // dialog is closed so a later delete never inherits a cancelled choice.
    setDontAskAgain(false)
  }

  useEffect(() => {
    if (isOpen && worktreeIds.length > 0 && worktrees.length === 0 && !isDeleting) {
      for (const target of deleteStateTargets) {
        clearWorktreeDeleteState(target.id, target.hostId)
      }
      closeModal()
    }
  }, [
    clearWorktreeDeleteState,
    closeModal,
    deleteStateTargets,
    isDeleting,
    isOpen,
    worktreeIds,
    worktreeIds.length,
    worktrees.length
  ])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        return
      }
      const state = useAppStore.getState().deleteStateByWorktreeId
      const currentTarget = deleteStateTargets.find((target) => target.id === worktreeId)
      const currentState = currentTarget
        ? getDeleteStateForWorktreeHost(currentTarget, state)
        : undefined
      if (isBatchDelete) {
        for (const target of deleteStateTargets) {
          if (!getDeleteStateForWorktreeHost(target, state)?.isDeleting) {
            clearWorktreeDeleteState(target.id, target.hostId)
          }
        }
      } else if (worktreeId && !currentState?.isDeleting) {
        clearWorktreeDeleteState(worktreeId, currentTarget?.hostId)
      }
      closeModal()
    },
    [clearWorktreeDeleteState, closeModal, deleteStateTargets, isBatchDelete, worktreeId]
  )

  const persistDontAskAgainPreference = useCallback((): void => {
    persistDeleteWorktreeConfirmSkipPreference({
      updateSettings,
      openSettingsPage,
      openSettingsTarget
    })
  }, [openSettingsPage, openSettingsTarget, updateSettings])

  const handleForceDeletedFromToast = useCallback(
    (deletedTarget: WorktreeRemovalTarget): void => {
      onDeleted?.([deletedTarget])
    },
    [onDeleted]
  )

  const handleDelete = useCallback(
    (force = false) => {
      if (worktreeIds.length === 0) {
        return
      }
      const currentWorktrees = resolveConfirmedTargets(worktreeDeleteIdentities, worktreeIds.length)
      if (!currentWorktrees) {
        return
      }
      // Why: force-delete is a recovery path taken after a failed first delete.
      // Saving "don't ask again" from that state would conflate the recovery
      // action with a broader preference. Only persist the preference on the
      // primary (non-force) confirmation so users intentionally opt in.
      if (dontAskAgain && allowSkipConfirm && !force) {
        persistDontAskAgainPreference()
      }
      if (force) {
        // Why: this branch preserves the legacy "Force Delete" button behavior
        // inside the dialog — it runs the destructive retry directly without
        // the shared toast wrapper. Close immediately because workspace cards
        // already show the deleting state while the retry runs.
        // Why the lookup (STA-4343): the confirmed row carries the host the
        // removal must land on; a bare id would let force delete another host's
        // checkout at the same path.
        const forceTarget = currentWorktrees.find((entry) => entry.id === worktreeId)
        if (!forceTarget) {
          // Same recovery as a stale confirmed batch: say so and close, rather
          // than leaving a destructive button that silently does nothing.
          showWorkspaceListChangedToast()
          closeModal()
          return
        }
        const commitFocus = prepareActiveWorktreeFocusAfterDelete(worktreeId)
        // Why (#11960): this IS the explicit Force Delete, so it may also waive
        // the PTY-stop proof — unlike the confirmed delete in the branch below.
        const deletePromise = removeWorktree(toWorktreeRemovalTarget(forceTarget), true, {
          allowUnverifiedPtyStop: true
        })
        closeModal()
        deletePromise
          .then((result) => {
            if (!result.ok) {
              toast.error(
                translate(
                  'auto.components.sidebar.DeleteWorktreeDialog.42e610d6cf',
                  'Force delete failed'
                ),
                {
                  description: result.error
                }
              )
              return
            }
            commitFocus()
            onDeleted?.([toWorktreeRemovalTarget(forceTarget)])
          })
          .catch((err: unknown) => {
            toast.error(
              translate(
                'auto.components.sidebar.DeleteWorktreeDialog.4f6750ca7b',
                'Failed to delete workspace'
              ),
              {
                description: err instanceof Error ? err.message : String(err)
              }
            )
          })
      } else {
        // Why: this modal is the destructive confirmation for the workspace
        // folder. Running a non-force remove here just turns dirty files into
        // a redundant Force Delete toast after the user already confirmed.
        const deletePromise = runWorktreeDeletesInParallel(currentWorktrees, {
          force: forceOnConfirm,
          onForceDeleted: handleForceDeletedFromToast
        })
        // Why: the workspace card owns the in-progress feedback, so the
        // confirmation should get out of the way as soon as deletion begins.
        closeModal()
        void deletePromise.then((deletedTargets) => {
          if (deletedTargets.length > 0) {
            onDeleted?.(deletedTargets)
          }
        })
      }
    },
    [
      closeModal,
      dontAskAgain,
      allowSkipConfirm,
      handleForceDeletedFromToast,
      forceOnConfirm,
      onDeleted,
      persistDontAskAgainPreference,
      removeWorktree,
      worktreeIds.length,
      worktreeDeleteIdentities,
      worktreeId,
      resolveConfirmedTargets
    ]
  )

  const handleDeleteAll = useCallback(() => {
    if (lineageDelete.deleteAllTargets.length <= 1) {
      return
    }
    const currentTargets = resolveConfirmedTargets(
      lineageDeleteIdentities,
      lineageDelete.deleteAllTargets.length
    )
    if (!currentTargets) {
      return
    }
    // Why: the lineage modal confirms every affected workspace up front, so
    // dirty child workspaces should not create per-workspace force prompts.
    const deletePromise = runWorktreeDeletesInParallel(currentTargets, {
      force: forceOnConfirm,
      onForceDeleted: handleForceDeletedFromToast
    })
    // Why: deletion progress is shown on the workspace cards; the modal should
    // not sit on top of that in-progress UI.
    closeModal()
    void deletePromise.then((deletedTargets) => {
      if (deletedTargets.length > 0) {
        onDeleted?.(deletedTargets)
      }
    })
  }, [
    closeModal,
    handleForceDeletedFromToast,
    forceOnConfirm,
    lineageDelete.deleteAllTargets.length,
    lineageDeleteIdentities,
    onDeleted,
    resolveConfirmedTargets
  ])

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(event) => {
          if (isMainWorktree) {
            return
          }
          event.preventDefault()
          // Why: this confirmation dialog exists specifically to guard a
          // destructive action the user already chose from the context menu.
          // Radix otherwise picks the first tabbable control, which can be the
          // cancel/close affordance and breaks the expected "Delete, Enter"
          // flow for quick keyboard confirmation.
          confirmButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {isBatchDelete
              ? translate(
                  'auto.components.sidebar.DeleteWorktreeDialog.86f0ae1257',
                  'Delete Workspaces'
                )
              : translate(
                  'auto.components.sidebar.DeleteWorktreeDialog.fc23c4cbdf',
                  'Delete Workspace'
                )}
          </DialogTitle>
          <DeleteWorktreeDialogDescription
            targetClassName={deleteCopy.targetClassName}
            targetLabel={deleteCopy.targetLabel}
            canDeleteAllLineage={canDeleteAllLineage}
            childTargetLabel={lineageDeleteCopy.childTargetLabel}
            descriptionSuffix={
              canDeleteAllLineage
                ? lineageDeleteCopy.descriptionSuffix
                : deleteCopy.descriptionSuffix
            }
          />
        </DialogHeader>

        <DeleteWorktreeTargetPreview
          isBatchDelete={isBatchDelete}
          worktree={worktree}
          worktrees={worktrees}
          deleteStateByWorktreeId={deleteStateByWorktreeId}
          dirtyChangeCountsByWorktreeId={dirtyChangeCountsByWorktreeId}
        />

        {hasLineageChildren && (
          <DeleteWorktreeLineageNotice
            descendants={lineageDelete.descendants}
            dirtyChangeCountsByWorktreeId={dirtyChangeCountsByWorktreeId}
          />
        )}

        <DeleteWorktreeWarningPanels
          isMainWorktree={isMainWorktree}
          mainWorktreeBlocker={deleteCopy.mainWorktreeBlocker}
          deleteError={deleteError}
        />

        <DeleteWorktreeSkipConfirmOption
          showDontAskAgain={!isMainWorktree && allowSkipConfirm && !canForceDelete}
          dontAskAgain={dontAskAgain}
          onToggleDontAskAgain={() => setDontAskAgain((prev) => !prev)}
        />

        <DialogFooter>
          <DeleteWorktreeDialogFooter
            isMainWorktree={isMainWorktree}
            isDeleting={isDeleting}
            canForceDelete={canForceDelete}
            isBatchDelete={isBatchDelete}
            worktreeCount={worktrees.length}
            canDeleteAllLineage={canDeleteAllLineage}
            lineageDeleteTargetCount={lineageDelete.deleteAllTargets.length}
            onCancel={() => handleOpenChange(false)}
            onForceDelete={() => handleDelete(true)}
            onDelete={canDeleteAllLineage ? handleDeleteAll : () => handleDelete(false)}
            confirmButtonRef={confirmButtonRef}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default DeleteWorktreeDialog
