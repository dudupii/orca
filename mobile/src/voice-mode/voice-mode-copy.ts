import { translate } from '../i18n/mobile-i18n'
import type { VoiceLoopNotice, VoiceLoopRoute } from './voice-loop-shell-contract'

// One set of voice-mode labels for the overlay and the notices the session surface shows.
export const voiceModeCopy = {
  stateLabel: (route: VoiceLoopRoute): string => {
    switch (route) {
      case 'listening':
        return translate('voiceMode.state.listening', 'Listening…')
      case 'thinking':
        return translate('voiceMode.state.thinking', 'Thinking…')
      case 'speaking':
        return translate('voiceMode.state.speaking', 'Speaking…')
      case 'closed':
      case 'idle':
        return translate('voiceMode.state.title', 'Voice mode')
    }
  },
  exit: () => translate('voiceMode.exit', 'Exit voice mode'),
  pillLabel: (state: string, title: string) =>
    translate('voiceMode.pill.label', '{{state}} in {{title}}', { state, title }),
  pillHint: () => translate('voiceMode.pill.hint', 'Double-tap to go back to the conversation'),
  stopReadout: () => translate('voiceMode.stopReadout', 'Stop readout'),
  pendingHint: () => translate('voiceMode.pendingHint', 'Tap to cancel sending'),
  pendingLabel: (utterance: string) =>
    translate('voiceMode.pendingLabel', '{{utterance}}. Tap to cancel sending.', { utterance }),
  notice: (notice: VoiceLoopNotice): string => {
    switch (notice) {
      case 'mic-exclusive':
        return translate(
          'voiceMode.notice.micExclusive',
          'Another voice session is using the microphone.'
        )
      case 'mic-unavailable':
        return translate('voiceMode.notice.micUnavailable', 'Voice mode needs the microphone.')
      case 'speech-failed':
        return translate(
          'voiceMode.notice.speechFailed',
          'Voice mode stopped: speech recognition failed.'
        )
      case 'send-failed':
        return translate(
          'voiceMode.notice.sendFailed',
          'Voice mode stopped: the message could not be sent.'
        )
    }
  }
}
