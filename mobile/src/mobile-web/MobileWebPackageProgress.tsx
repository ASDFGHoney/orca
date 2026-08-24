import { Text, View } from 'react-native'
import { hybridShellStyles as styles } from './hybrid-shell-styles'
import type { MobileWebPackageDownloadProgress } from './mobile-web-package-downloader'

export function MobileWebPackageProgress({
  progress
}: {
  progress: MobileWebPackageDownloadProgress
}) {
  const percent =
    progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.completedBytes / progress.totalBytes) * 100))
      : 0
  const label =
    progress.phase === 'downloading'
      ? `Downloading workspace interface… ${percent}%`
      : progress.phase === 'verifying'
        ? 'Verifying workspace interface…'
        : 'Starting workspace interface…'

  return (
    <View
      style={styles.packageProgress}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: percent }}
    >
      <Text accessibilityLiveRegion="polite" style={styles.packageProgressLabel}>
        {label}
      </Text>
      <View style={styles.packageProgressTrack}>
        <View style={[styles.packageProgressFill, { width: `${percent}%` }]} />
      </View>
      <Text style={styles.packageProgressBytes}>
        {formatBytes(progress.completedBytes)} of {formatBytes(progress.totalBytes)}
      </Text>
    </View>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
