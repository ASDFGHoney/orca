import { ChevronDown, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type {
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'
import {
  nativeChatSessionChoiceLabel,
  nativeChatSessionOptionDisabledReason,
  nativeChatSessionOptionLabel
} from './native-chat-session-option-labels'

function PickerTooltipContent(props: {
  label: string
  disabledReason?: string | null
  dispatched: boolean
}): React.JSX.Element {
  return (
    <div className="space-y-0.5">
      <div>{props.disabledReason ?? props.label}</div>
      {props.dispatched ? (
        <div>
          {translate(
            'components.native-chat.composer.sentNotConfirmed',
            'Sent to the agent — not confirmed'
          )}
        </div>
      ) : null}
    </div>
  )
}

export function NativeChatSessionOptionTrigger(props: {
  label: string
  tooltipLabel: string
  disabled: boolean
  disabledReason?: string | null
  dispatched: boolean
  modelAndEffort?: boolean
}): React.JSX.Element {
  // Why: value-only visible text must still include the category in the
  // accessible name (WCAG 2.5.3 Label in Name / voice control).
  const accessibleName =
    props.label === props.tooltipLabel
      ? props.tooltipLabel
      : translate('components.native-chat.composer.pillAccessibleName', '{{value0}} {{value1}}', {
          value0: props.tooltipLabel,
          value1: props.label
        })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuTrigger asChild disabled={props.disabled}>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={accessibleName}
            className="max-w-48 text-muted-foreground"
          >
            {props.modelAndEffort ? <Zap className="size-3" /> : null}
            <span className="truncate">{props.label}</span>
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        <PickerTooltipContent
          label={props.tooltipLabel}
          disabledReason={props.disabledReason}
          dispatched={props.dispatched}
        />
      </TooltipContent>
    </Tooltip>
  )
}

function ChoiceBody(props: { label: string; description?: string }): React.JSX.Element {
  return (
    <div className="min-w-0 py-0.5">
      <div>{props.label}</div>
      {props.description ? (
        <div className="text-xs font-normal text-muted-foreground">{props.description}</div>
      ) : null}
    </div>
  )
}

function DescriptorMenuRows(props: {
  descriptor: SessionOptionDescriptor
  pending: boolean
  setValue: (value: SessionOptionValue) => void
  invokeAction: () => void
}): React.JSX.Element {
  const { descriptor, pending, setValue, invokeAction } = props
  if (descriptor.action?.type === 'toggle-command') {
    return (
      <DropdownMenuItem disabled={!descriptor.settable || pending} onSelect={() => invokeAction()}>
        {translate('components.native-chat.composer.toggleOption', 'Toggle {{value0}}', {
          value0: nativeChatSessionOptionLabel(descriptor).toLowerCase()
        })}
      </DropdownMenuItem>
    )
  }
  if (descriptor.action?.type === 'agent-picker') {
    return (
      <DropdownMenuItem disabled={!descriptor.settable || pending} onSelect={() => invokeAction()}>
        {translate(
          'components.native-chat.composer.chooseInAgentPicker',
          'Choose in agent picker…'
        )}
      </DropdownMenuItem>
    )
  }
  if (descriptor.kind.type === 'boolean') {
    const selected =
      descriptor.kind.currentValue === true
        ? 'on'
        : descriptor.kind.currentValue === false
          ? 'off'
          : undefined
    return (
      <>
        {selected === undefined ? (
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            {translate(
              'components.native-chat.composer.valueUnknown',
              'Current value unknown — pick On or Off'
            )}
          </DropdownMenuLabel>
        ) : null}
        <DropdownMenuRadioGroup value={selected} onValueChange={(next) => setValue(next === 'on')}>
          <DropdownMenuRadioItem value="on" disabled={!descriptor.settable || pending}>
            {translate('components.native-chat.composer.optionValue.on', 'On')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="off" disabled={!descriptor.settable || pending}>
            {translate('components.native-chat.composer.optionValue.off', 'Off')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </>
    )
  }
  return (
    <DropdownMenuRadioGroup
      value={descriptor.kind.currentValue}
      onValueChange={(value) => setValue(value)}
    >
      {descriptor.kind.choices.map((choice) => (
        <DropdownMenuRadioItem
          key={choice.value}
          value={choice.value}
          disabled={!descriptor.settable || pending}
        >
          <ChoiceBody
            label={nativeChatSessionChoiceLabel(choice)}
            description={choice.description}
          />
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

export function NativeChatSessionOptionMenuSection(props: {
  descriptor: SessionOptionDescriptor
  pending: boolean
  divided?: boolean
  setOption: (descriptor: SessionOptionDescriptor, value: SessionOptionValue) => void
  invokeAction: (descriptor: SessionOptionDescriptor) => void
}): React.JSX.Element {
  const reason = nativeChatSessionOptionDisabledReason(props.descriptor.disabledReason)
  return (
    <>
      {props.divided ? <DropdownMenuSeparator /> : null}
      <DropdownMenuLabel>{nativeChatSessionOptionLabel(props.descriptor)}</DropdownMenuLabel>
      {reason && !props.descriptor.settable ? (
        <DropdownMenuLabel className="font-normal">{reason}</DropdownMenuLabel>
      ) : null}
      <DescriptorMenuRows
        descriptor={props.descriptor}
        pending={props.pending}
        setValue={(value) => props.setOption(props.descriptor, value)}
        invokeAction={() => props.invokeAction(props.descriptor)}
      />
    </>
  )
}

export function runNativeChatSessionOptionCall(
  pendingKey: string,
  setPendingId: (id: string | null) => void,
  call: () => Promise<unknown>
): void {
  setPendingId(pendingKey)
  void call()
    .catch((error) => {
      toast.error(
        translate('components.native-chat.composer.optionUpdateFailed', 'Could not update option'),
        { description: error instanceof Error ? error.message : String(error) }
      )
    })
    .finally(() => setPendingId(null))
}
