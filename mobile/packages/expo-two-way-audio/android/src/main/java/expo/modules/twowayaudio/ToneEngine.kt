package expo.modules.twowayaudio

import android.media.AudioManager
import android.media.ToneGenerator

// The phone's short chimes. The generator plays on the voice-call stream so a chime rides the
// communication path the open microphone's echo canceler subtracts; a speaker-stream chime would
// echo into recognition.
internal class ToneEngine {
    private val lock = Any()
    private var generator: ToneGenerator? = null

    // Synchronous and never throws: an unavailable generator or an unknown kind is a silent
    // chime, never a failed call.
    fun play(kind: String) {
        val tone = when (kind) {
            "restore" -> ToneGenerator.TONE_PROP_BEEP2
            else -> return
        }
        val held = synchronized(lock) {
            generator ?: runCatching {
                ToneGenerator(STREAM, VOLUME).also { generator = it }
            }.getOrNull()
        } ?: return
        runCatching { held.startTone(tone) }
    }

    fun destroy() {
        val held = synchronized(lock) {
            val current = generator ?: return
            generator = null
            current
        }
        runCatching { held.release() }
    }

    private companion object {
        // The communication stream the audio engine's mode and routing already claim.
        const val STREAM = AudioManager.STREAM_VOICE_CALL
        // ToneGenerator volumes run 0-100; loud enough over the earpiece without startling.
        const val VOLUME = 60
    }
}
