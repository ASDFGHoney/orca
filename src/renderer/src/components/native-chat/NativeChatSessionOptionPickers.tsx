import { memo, useState } from 'react'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { sortNativeChatSessionOptions } from '../../../../shared/native-chat-session-option-snapshot'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'
import {
  nativeChatModelAndEffortPillLabel,
  nativeChatOptionsPillLabel,
  nativeChatOptionsPillTitle,
  nativeChatSessionOptionDisabledReason,
  nativeChatSessionOptionLabel
} from './native-chat-session-option-labels'
import type { NativeChatOptionPickerRequest } from './native-chat-composer-types'
import {
  NativeChatSessionOptionMenuSection,
  NativeChatSessionOptionTrigger,
  runNativeChatSessionOptionCall
} from './NativeChatSessionOptionMenu'

export type NativeChatSessionOptionPickersProps = {
  surface: SessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
  isWorking: boolean
  pickerRequest?: NativeChatOptionPickerRequest | null
}

function NativeChatSessionOptionPickersInner({
  surface,
  snapshot,
  isWorking,
  pickerRequest
}: NativeChatSessionOptionPickersProps): React.JSX.Element | null {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const model = snapshot.find((descriptor) => descriptor.category === 'model')
  const options = sortNativeChatSessionOptions(snapshot)
  const effort = options.find((descriptor) => descriptor.category === 'thought_level')
  const additionalOptions = options.filter((descriptor) => descriptor !== effort)
  if (!surface || !model) {
    return null
  }
  const requestedModelSequence =
    pickerRequest && (pickerRequest.id === model.id || pickerRequest.id === effort?.id)
      ? pickerRequest.sequence
      : null
  const requestedOptionsSequence = additionalOptions.some(
    (descriptor) => descriptor.id === pickerRequest?.id
  )
    ? (pickerRequest?.sequence ?? null)
    : null

  const setOption = (descriptor: SessionOptionDescriptor, value: SessionOptionValue): void => {
    runNativeChatSessionOptionCall(descriptor.id, setPendingId, () =>
      surface.setOption(descriptor.id, value)
    )
  }
  const invokeAction = (descriptor: SessionOptionDescriptor): void => {
    runNativeChatSessionOptionCall(descriptor.id, setPendingId, () =>
      surface.invokeAction(descriptor.id)
    )
  }

  const modelReason = nativeChatSessionOptionDisabledReason(model.disabledReason)
  const modelTooltip = translate('components.native-chat.composer.model', 'Model')
  const combinedTooltip = effort
    ? `${modelTooltip} · ${nativeChatSessionOptionLabel(effort)}`
    : modelTooltip
  const optionsTooltip = nativeChatOptionsPillTitle(additionalOptions)
  const optionsReason =
    additionalOptions.length > 0 && additionalOptions.every((descriptor) => !descriptor.settable)
      ? nativeChatSessionOptionDisabledReason(additionalOptions[0]?.disabledReason)
      : null

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      {additionalOptions.length > 0 ? (
        <DropdownMenu
          key={`options:${requestedOptionsSequence ?? 'idle'}`}
          defaultOpen={requestedOptionsSequence !== null}
        >
          <NativeChatSessionOptionTrigger
            label={nativeChatOptionsPillLabel(additionalOptions)}
            tooltipLabel={optionsTooltip}
            disabled={isWorking || pendingId !== null}
            disabledReason={optionsReason}
            dispatched={additionalOptions.some(
              (descriptor) => descriptor.valueSource === 'dispatched'
            )}
          />
          <DropdownMenuContent align="start" side="top" collisionPadding={8} className="w-60">
            {additionalOptions.map((descriptor, index) => (
              <NativeChatSessionOptionMenuSection
                key={descriptor.id}
                descriptor={descriptor}
                pending={pendingId !== null}
                divided={index > 0}
                setOption={setOption}
                invokeAction={invokeAction}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <DropdownMenu
        key={`model:${requestedModelSequence ?? 'idle'}`}
        defaultOpen={requestedModelSequence !== null}
      >
        <NativeChatSessionOptionTrigger
          label={nativeChatModelAndEffortPillLabel(model, effort)}
          tooltipLabel={combinedTooltip}
          disabled={isWorking || pendingId !== null}
          disabledReason={modelReason}
          dispatched={model.valueSource === 'dispatched' || effort?.valueSource === 'dispatched'}
          modelAndEffort
        />
        <DropdownMenuContent align="start" side="top" collisionPadding={8} className="w-64">
          <NativeChatSessionOptionMenuSection
            descriptor={model}
            pending={pendingId !== null}
            setOption={setOption}
            invokeAction={invokeAction}
          />
          {effort ? (
            <NativeChatSessionOptionMenuSection
              descriptor={effort}
              pending={pendingId !== null}
              divided
              setOption={setOption}
              invokeAction={invokeAction}
            />
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export const NativeChatSessionOptionPickers = memo(NativeChatSessionOptionPickersInner)
