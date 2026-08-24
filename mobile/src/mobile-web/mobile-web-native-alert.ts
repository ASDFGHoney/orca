import { Alert } from 'react-native'
import type {
  MobileWebNativeAlertPayload,
  MobileWebNativeAlertResult
} from '../../../src/shared/mobile-web/native-operation-contract'

type MobileWebNativeAlertTarget = Pick<typeof Alert, 'alert'>

export function presentMobileWebNativeAlert(
  payload: MobileWebNativeAlertPayload,
  target: MobileWebNativeAlertTarget = Alert
): Promise<MobileWebNativeAlertResult> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (result: MobileWebNativeAlertResult): void => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }
    target.alert(
      payload.title,
      payload.message,
      payload.buttons.map((button, buttonIndex) => ({
        ...button,
        onPress: () => settle({ kind: 'button', buttonIndex })
      })),
      {
        ...payload.options,
        onDismiss: () => settle({ kind: 'dismissed' })
      }
    )
  })
}
