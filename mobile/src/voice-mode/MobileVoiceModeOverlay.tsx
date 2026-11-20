import { Pressable, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { voiceModeCopy } from './voice-mode-copy'
import type { MobileSessionVoiceMode } from './use-mobile-session-voice-mode'

/**
 * The voice loop drawn over the chat: its route, the words heard so far (or the finalized
 * utterance waiting out the response delay, where a tap cancels the send), the silently
 * rendered reply, and the ✕ that exits voice mode. Touches outside the panel reach the chat.
 */
export function MobileVoiceModeOverlay({
  voiceMode
}: {
  voiceMode: MobileSessionVoiceMode
}): React.JSX.Element | null {
  useMobileColorScheme()
  useMobileTranslation()
  const { view, tapPending, exit } = voiceMode
  if (view.route === 'idle' || view.route === 'closed') {
    return null
  }
  const pending = view.pending
  return (
    <View style={styles.fill} pointerEvents="box-none">
      <View style={styles.panel}>
        <View style={styles.header}>
          <Text style={styles.state}>{voiceModeCopy.stateLabel(view.route)}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={voiceModeCopy.exit()}
            style={({ pressed }) => [styles.exit, pressed && styles.pressed]}
            onPress={exit}
          >
            <X pointerEvents="none" size={18} color={colors.textPrimary} strokeWidth={2.4} />
          </Pressable>
        </View>
        {view.reply ? (
          <Text style={styles.reply} numberOfLines={4}>
            {view.reply}
          </Text>
        ) : null}
        {pending !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={voiceModeCopy.pendingLabel(pending)}
            style={({ pressed }) => [styles.pending, pressed && styles.pressed]}
            onPress={tapPending}
          >
            <Text style={styles.pendingText}>{pending}</Text>
            <Text style={styles.pendingHint}>{voiceModeCopy.pendingHint()}</Text>
          </Pressable>
        ) : (
          <Text style={styles.transcript} numberOfLines={4}>
            {view.transcript}
          </Text>
        )}
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  fill: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: 'flex-end'
  },
  panel: {
    margin: spacing.md,
    padding: spacing.md,
    gap: spacing.sm,
    borderRadius: radii.floating,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  state: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  exit: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center'
  },
  pressed: {
    opacity: 0.7
  },
  reply: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  pending: {
    padding: spacing.sm,
    gap: 2,
    borderRadius: radii.control,
    backgroundColor: colors.translucentFill
  },
  pendingText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  pendingHint: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  transcript: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  }
}))
