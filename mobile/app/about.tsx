import { Linking, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import Constants from 'expo-constants'
import AboutScreen from '../src/settings/about-screen'
import { mobileVersionLabel } from '../src/settings/about-version-label'

// Why: read version + native build identifier from expo-constants at
// runtime so the About screen never drifts out of sync with app.json.
// nativeBuildVersion is iOS buildNumber on iOS and versionCode on
// Android — different concepts, same role (monotonic native build id).
// The variant names the fork's personal tag the workflow baked in at
// bundle time (Metro inlines EXPO_PUBLIC_* into the release JS); official
// builds set nothing and the label stays as it was.
const BUILD_VARIANT = process.env.EXPO_PUBLIC_ORCA_BUILD_VARIANT

function getVersionLabel(): string {
  const version = Constants.expoConfig?.version ?? '?.?.?'
  const build =
    Platform.OS === 'ios'
      ? Constants.expoConfig?.ios?.buildNumber
      : String(Constants.expoConfig?.android?.versionCode ?? '')
  return mobileVersionLabel({ version, build: build ?? '', variant: BUILD_VARIANT })
}

export default function NativeAboutRoute() {
  const router = useRouter()
  return (
    <AboutScreen
      onBack={() => router.back()}
      openExternal={(url) => Linking.openURL(url)}
      versionLabel={getVersionLabel()}
    />
  )
}
