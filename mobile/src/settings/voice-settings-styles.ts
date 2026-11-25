import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const voiceSettingsStyles = themedStyleSheet(() => ({
  drawerTitle: {
    fontSize: typography.bodySize,
    fontWeight: '700',
    color: colors.textPrimary,
    paddingHorizontal: spacing.md + 2,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs
  },
  // The free-form locale field sits on the sheetGroup surface, so it needs its own fill to read as a field.
  otherFieldWrap: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  otherField: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.md,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  otherError: {
    fontSize: 13,
    color: colors.statusRed,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  }
}))
