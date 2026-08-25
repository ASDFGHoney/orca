import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, ArrowLeft, RefreshCw } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

type Props = {
  children: ReactNode
  onGoBack: () => void
}

type State = {
  error: Error | null
  resetKey: number
}

export class MobileRootErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(
      '[mobile-root-error-boundary] render crash contained by boundary',
      error,
      errorInfo
    )
  }

  handleRetry = (): void => {
    this.setState(({ resetKey }) => ({ error: null, resetKey: resetKey + 1 }))
  }

  handleGoBack = (): void => {
    this.props.onGoBack()
    this.handleRetry()
  }

  render(): ReactNode {
    if (this.state.error) {
      return <MobileRootErrorFallback onRetry={this.handleRetry} onGoBack={this.handleGoBack} />
    }

    return <Fragment key={this.state.resetKey}>{this.props.children}</Fragment>
  }
}

function MobileRootErrorFallback({
  onRetry,
  onGoBack
}: {
  onRetry: () => void
  onGoBack: () => void
}): ReactNode {
  return (
    <View style={styles.container} accessibilityRole="alert" testID="mobile-root-error-boundary">
      <View style={styles.iconBadge}>
        <AlertTriangle size={20} color={colors.statusRed} />
      </View>
      <View style={styles.copy}>
        <Text style={styles.title}>This part of Orca hit an error.</Text>
        <Text style={styles.description}>
          The app is still running. Retry this screen or go back and continue elsewhere.
        </Text>
      </View>
      <View style={styles.actions}>
        <Pressable
          accessibilityLabel="Retry"
          accessibilityRole="button"
          style={styles.primaryButton}
          onPress={onRetry}
        >
          <RefreshCw size={16} color={colors.bgBase} />
          <Text style={styles.primaryButtonText}>Retry</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Go back"
          accessibilityRole="button"
          style={styles.secondaryButton}
          onPress={onGoBack}
        >
          <ArrowLeft size={16} color={colors.textSecondary} />
          <Text style={styles.secondaryButtonText}>Go back</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    padding: spacing.xl,
    backgroundColor: colors.bgBase
  },
  iconBadge: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.statusRed,
    backgroundColor: colors.bgPanel
  },
  copy: {
    alignItems: 'center',
    gap: spacing.sm,
    maxWidth: 420
  },
  title: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '600',
    textAlign: 'center'
  },
  description: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    lineHeight: 20,
    textAlign: 'center'
  },
  actions: {
    width: '100%',
    maxWidth: 360,
    gap: spacing.sm
  },
  primaryButton: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.button,
    backgroundColor: colors.surfaceBright
  },
  primaryButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  secondaryButton: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.button
  },
  secondaryButtonText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  }
})
