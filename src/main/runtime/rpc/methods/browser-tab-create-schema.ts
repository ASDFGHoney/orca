import { z } from 'zod'
import { OptionalString } from '../schemas'
import { BrowserPageCreationPlacement } from '../../../../shared/browser-client-host-placement'

export const BrowserTabCreateParams = z.object({
  url: OptionalString,
  worktree: OptionalString,
  page: OptionalString,
  profileId: OptionalString,
  waitForRegistration: z.boolean().optional(),
  activate: z.boolean().optional(),
  targetGroupId: OptionalString,
  placement: BrowserPageCreationPlacement.optional()
})
