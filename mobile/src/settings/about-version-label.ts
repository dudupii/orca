/** The About screen's version line. */
export function mobileVersionLabel(args: {
  version: string
  build: string
  /** Set only by the fork's release workflow (`EXPO_PUBLIC_ORCA_BUILD_VARIANT`), naming the exact personal tag an APK was built from. */
  variant?: string | undefined
}): string {
  const base = args.build ? `v${args.version} (${args.build})` : `v${args.version}`
  return args.variant ? `${base} · ${args.variant}` : base
}
