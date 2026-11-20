import { useContext, useEffect, useSyncExternalStore } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { X } from 'lucide-react-native'
import { MobileDictationPillContext } from '../dictation/mobile-dictation-host-context'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileVoiceModeHost, MobileVoiceModePillContext } from './voice-mode-host-context'
import { voiceModeCopy } from './voice-mode-copy'
import type { VoiceLoopRoute } from './voice-loop-shell-contract'

const TOAST_MS = 4000

// Each running state carries its own tint: a live microphone, a working turn, a spoken reply.
function stateColor(route: VoiceLoopRoute): string {
  if (route === 'listening') {
    return colors.statusRed
  }
  if (route === 'speaking') {
    return colors.accentBlue
  }
  return colors.textMuted
}

/**
 * The voice loop while its chat is elsewhere: the state it is in, a tap back into the
 * conversation, and the ✕ that ends voice mode. Reads the host's view alone — never the
 * playback or the loop's own internals.
 */
function MobileVoiceModePill(): React.JSX.Element | null {
  const host = useMobileVoiceModeHost()
  // Subscribed only while the pill shows, so the loop's ticks re-render only the standing pill.
  const { view, owner } = useSyncExternalStore(host.subscribe, host.getLive)
  if (view.route === 'idle' || view.route === 'closed') {
    return null
  }
  const title = owner?.title ?? ''
  return (
    <View style={styles.pill}>
      <Pressable
        style={({ pressed }) => [styles.body, pressed && styles.pressed]}
        onPress={host.open}
        accessibilityRole="button"
        accessibilityLabel={
          title
            ? voiceModeCopy.pillLabel(voiceModeCopy.stateLabel(view.route), title)
            : voiceModeCopy.stateLabel(view.route)
        }
        accessibilityHint={voiceModeCopy.pillHint()}
      >
        <View style={[styles.dot, { backgroundColor: stateColor(view.route) }]} />
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.state} numberOfLines={1}>
          {voiceModeCopy.stateLabel(view.route)}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={voiceModeCopy.exit()}
        style={({ pressed }) => [styles.exit, pressed && styles.pressed]}
        onPress={host.exit}
      >
        <X pointerEvents="none" size={18} color={colors.textPrimary} strokeWidth={2.4} />
      </Pressable>
    </View>
  )
}

// A notice that landed while no screen stood for the chat; it reads for a while, then clears.
function MobileVoiceModeToast({
  message,
  onDone,
  bottom
}: {
  message: string | null
  onDone: () => void
  bottom: number
}): React.JSX.Element {
  useEffect(() => {
    if (!message) {
      return
    }
    const timer = setTimeout(onDone, TOAST_MS)
    return () => clearTimeout(timer)
  }, [onDone, message])
  return (
    <View style={[styles.toastRow, { bottom }]} pointerEvents="box-none">
      {message ? (
        <View style={styles.toast}>
          <Text style={styles.toastText} numberOfLines={2}>
            {message}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

// Floats over every screen of the host document while the voice loop runs from another one.
export function MobileVoiceModePillLayer(): React.JSX.Element | null {
  useMobileColorScheme()
  useMobileTranslation()
  const insets = useSafeAreaInsets()
  const pill = useContext(MobileVoiceModePillContext)
  // The page's bottom bars report their height to the dictation pill's registry; this pill floats above them too.
  const clearance = useContext(MobileDictationPillContext)?.clearance ?? 0
  if (!pill) {
    return null
  }
  // Above the home indicator, or above a screen's bottom bar when it reported one.
  const pillBottom = Math.max(insets.bottom + spacing.md, clearance + spacing.sm)
  return (
    <>
      {pill.away ? (
        <View style={[styles.layer, { bottom: pillBottom }]} pointerEvents="box-none">
          <MobileVoiceModePill />
        </View>
      ) : null}
      <MobileVoiceModeToast
        message={pill.toast}
        onDone={pill.clearToast}
        bottom={pillBottom + (pill.away ? PILL_HEIGHT + spacing.sm : 0)}
      />
    </>
  )
}

const PILL_HEIGHT = 44

const styles = themedStyleSheet(() => ({
  // Above every screen's own floating controls, just under the dictation pill (the page's mic holder) and below the host's pending cover (1000).
  layer: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    zIndex: 890,
    elevation: 8
  },
  pill: {
    height: PILL_HEIGHT,
    borderRadius: radii.pill,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8
  },
  body: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    alignSelf: 'stretch'
  },
  pressed: {
    opacity: 0.7
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  title: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  state: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  exit: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center'
  },
  toastRow: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    alignItems: 'center',
    zIndex: 890,
    elevation: 8
  },
  toast: {
    maxWidth: 360,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  toastText: {
    color: colors.textPrimary,
    fontSize: 13
  }
}))
