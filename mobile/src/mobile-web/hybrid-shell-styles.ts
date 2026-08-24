import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const hybridShellStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  header: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  headerButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1, minWidth: 0 },
  heading: { color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
  headerMeta: { color: colors.textMuted, fontSize: 11, marginTop: 1 },
  hostsButton: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  hostsButtonText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  webContainer: { flex: 1, minHeight: 0 },
  webView: { flex: 1, backgroundColor: colors.bgBase },
  warning: {
    color: colors.textSecondary,
    backgroundColor: colors.bgRaised,
    fontSize: typography.metaSize,
    lineHeight: 17,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  recoveryActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm
  },
  recoveryButton: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    paddingHorizontal: spacing.sm
  },
  recoveryButtonPressed: { backgroundColor: colors.bgBase },
  recoveryButtonDisabled: { opacity: 0.6 },
  recoveryButtonText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  loadingState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl
  },
  loadingTitle: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  loadingBody: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: 18,
    textAlign: 'center'
  },
  packageProgress: { width: '100%', maxWidth: 320, gap: spacing.xs },
  packageProgressLabel: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    textAlign: 'center'
  },
  packageProgressTrack: {
    height: 6,
    overflow: 'hidden',
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  packageProgressFill: {
    height: '100%',
    borderRadius: radii.button,
    backgroundColor: colors.textSecondary
  },
  packageProgressBytes: { color: colors.textMuted, fontSize: 11, textAlign: 'center' }
})
