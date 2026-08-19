import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import { defineMethod, type RpcMethod } from '../core'
import {
  FeatureInteractionIdParam,
  PRBotAuthorOverrideUpdate,
  SettingsUpdate,
  UiUpdate
} from './client-ui-schemas'
// Type-only side effect: keeps the schema/PersistedUIState parity assertions in
// the typecheck graph so drift fails the build instead of a paired client.

import { TerminalQuickCommandsUpdate } from './terminal-quick-command-rpc-schema'

export const CLIENT_UI_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'settings.get',
    params: null,
    handler: (_params, { runtime }) => ({ settings: runtime.getClientSettings() })
  }),
  defineMethod({
    name: 'settings.update',
    params: SettingsUpdate,
    handler: async (params, { runtime }) => ({
      settings: await runtime.updateClientSettings(params)
    })
  }),
  defineMethod({
    name: 'settings.getTerminalQuickCommands',
    params: null,
    // Why: command bodies can total ~240 KB, so keep unrelated settings reads
    // from carrying them over every paired/relay connection.
    handler: (_params, { runtime }) => ({
      terminalQuickCommands: runtime.getClientTerminalQuickCommands()
    })
  }),
  defineMethod({
    name: 'settings.updateTerminalQuickCommands',
    params: TerminalQuickCommandsUpdate,
    handler: (params, { runtime }) => ({
      terminalQuickCommands: runtime.updateClientTerminalQuickCommands(params.mutation)
    })
  }),
  defineMethod({
    name: 'settings.updatePRBotAuthorOverride',
    params: PRBotAuthorOverrideUpdate,
    handler: (params, { runtime }) => ({
      settings: runtime.updateClientPRBotAuthorOverride(params)
    })
  }),
  defineMethod({
    name: 'ui.get',
    params: null,
    handler: (_params, { runtime }) => ({ ui: runtime.getUIState() })
  }),
  defineMethod({
    name: 'ui.set',
    params: UiUpdate,
    // Why manualRepoOrder is dropped rather than removed from the schema: a paired client keys
    // its overlay to its own execution hosts, so forwarding it blind-replaces the desktop's
    // order. The strict schema still has to accept the field or old clients' whole payload fails.
    handler: (params, { runtime }) => {
      const {
        hideWorkspacesFromOtherDevices: _clientLocalFilter,
        manualRepoOrder: _desktopOwnedOrder,
        ...hostUpdates
      } = params
      void _clientLocalFilter
      void _desktopOwnedOrder
      return { ui: runtime.updateUIState(hostUpdates as Partial<PersistedUIState>) }
    }
  }),
  defineMethod({
    name: 'ui.recordFeatureInteraction',
    params: FeatureInteractionIdParam,
    handler: (params, { runtime }) => ({
      ui: runtime.recordFeatureInteraction(params)
    })
  })
]
