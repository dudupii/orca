package expo.modules.twowayaudio

import android.content.Context
import android.content.res.Resources
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

internal const val TTS_DONE_EVENT = "onTtsDone"
internal const val TTS_ERROR_EVENT = "onTtsError"

// The phone's system text-to-speech, one utterance at a time. Interruption is the seam server's contract;
// speak flushes whatever is still playing, stop silences the speaker.
internal class TtsEngine(
  private val context: Context,
  private val sendEvent: (String, Map<String, Any?>) -> Unit
) {
  private val lock = Any()
  // Speaks are serialized so a warm and a speak can never interleave on one engine.
  private val speaking = Mutex()
  private var engine: TextToSpeech? = null
  private var engineReady = false

  private val progress = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String?) = Unit

    // Fires on the TTS service's thread, keyed by the utteranceId the speak was given.
    override fun onDone(utteranceId: String?) {
      if (utteranceId != null) sendEvent(TTS_DONE_EVENT, mapOf("utteranceId" to utteranceId))
    }

    override fun onError(utteranceId: String?) = emitError(utteranceId)

    override fun onError(utteranceId: String?, errorCode: Int) = emitError(utteranceId)

    private fun emitError(utteranceId: String?) {
      if (utteranceId != null) {
        sendEvent(TTS_ERROR_EVENT, mapOf("utteranceId" to utteranceId, "code" to "failed"))
      }
    }
  }

  suspend fun speak(utteranceId: String, text: String, locale: String?): Map<String, Any?> =
    speaking.withLock {
      when (val warmed = warm()) {
        is Warm.Busy -> notStarted("busy")
        is Warm.Failed -> notStarted("unsupported")
        is Warm.Ready -> speakTaken(warmed.tts, utteranceId, text, locale)
      }
    }

  // Synchronous and never throws; safe with nothing playing.
  fun stop() {
    val tts = synchronized(lock) { engine } ?: return
    context.mainExecutor.execute { tts.stop() }
  }

  fun destroy() {
    val tts = synchronized(lock) {
      val current = engine ?: return
      engine = null
      engineReady = false
      current
    }
    context.mainExecutor.execute {
      tts.stop()
      tts.shutdown()
    }
  }

  private sealed interface Warm {
    data class Ready(val tts: TextToSpeech) : Warm
    data object Busy : Warm
    data object Failed : Warm
  }

  // A cold TTS binds its service, which can take a moment on a loaded phone: a slow one is busy, not
  // unsupported, so the caller asks again rather than remembering the phone as speechless.
  private suspend fun warm(): Warm {
    val ready = synchronized(lock) { if (engineReady) engine else null }
    if (ready != null) return Warm.Ready(ready)
    val init = CompletableDeferred<Int>()
    val created = withContext(Dispatchers.Main) {
      TextToSpeech(context) { status -> init.complete(status) }.also { tts ->
        tts.setOnUtteranceProgressListener(progress)
        synchronized(lock) { engine = tts }
      }
    }
    val status = withTimeoutOrNull(WARM_TIMEOUT_MS) { init.await() }
    if (status == TextToSpeech.SUCCESS) {
      synchronized(lock) { engineReady = true }
      return Warm.Ready(created)
    }
    // A dead or slow engine is dropped so the next ask rebinds the service.
    synchronized(lock) {
      if (engine === created) engine = null
      engineReady = false
    }
    withContext(Dispatchers.Main) { runCatching { created.shutdown() } }
    return if (status == null) Warm.Busy else Warm.Failed
  }

  private suspend fun speakTaken(
    tts: TextToSpeech,
    utteranceId: String,
    text: String,
    locale: String?
  ): Map<String, Any?> {
    val system = Resources.getSystem().configuration.locales[0]
    val language: Locale? = withContext(Dispatchers.Main) {
      // The recognizer's locale candidates pick the spoken language too, so one naming rule covers the heard and the spoken.
      speechLocaleCandidates(locale ?: "", system).firstOrNull { candidate ->
        when (tts.isLanguageAvailable(candidate)) {
          TextToSpeech.LANG_MISSING_DATA, TextToSpeech.LANG_NOT_SUPPORTED -> false
          else -> true
        }
      }
    }
    if (language == null) return notStarted("unsupported")
    // QUEUE_FLUSH: a new utterance replaces whatever is still playing, the server's stop notwithstanding.
    val queued = withContext(Dispatchers.Main) {
      tts.setLanguage(language)
      tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
    }
    return if (queued == TextToSpeech.SUCCESS) mapOf("started" to true) else notStarted("failed")
  }

  private fun notStarted(reason: String) = mapOf("started" to false, "reason" to reason)

  private companion object {
    // A cold bind of the TTS service can take seconds on a loaded phone.
    const val WARM_TIMEOUT_MS = 5_000L
  }
}
