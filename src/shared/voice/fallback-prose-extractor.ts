/**
 * The spoken fallback when a reply carries no readout-ready summary: its first sentences,
 * with fenced code and markdown scaffolding removed, capped for readout length.
 */
export const MAX_READOUT_SENTENCES = 3

export function condenseReplyForReadout(reply: string): string {
  const withoutFences = reply.replace(/```[\s\S]*?(?:```|$)/g, '')
  const blocks: string[] = []
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push(paragraph.join(' '))
      paragraph = []
    }
  }
  for (const line of withoutFences.split('\n')) {
    const cleaned = cleanReadoutLine(line)
    if (!cleaned.text) {
      flush()
      continue
    }
    if (cleaned.isItem) {
      // A list item stands alone; flowing prose around it joins into paragraphs.
      flush()
      blocks.push(cleaned.text)
    } else {
      paragraph.push(cleaned.text)
    }
  }
  flush()
  return blocks
    .flatMap((block) => splitReadoutSentences(block))
    .slice(0, MAX_READOUT_SENTENCES)
    .join(' ')
}

function cleanReadoutLine(line: string): { text: string; isItem: boolean } {
  const text = line
    .replace(/^\s*>+\s*/, '')
    .replace(/^#{1,6}\s+/, '')
    .trim()
  if (!text) {
    return { text: '', isItem: false }
  }
  const item = text.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/)
  return item ? { text: item[1]!.trim(), isItem: true } : { text, isItem: false }
}

/** Splits after a run of sentence terminators followed by whitespace or the end; decimals like 1.5 stay inside. */
function splitReadoutSentences(text: string): string[] {
  const sentences: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (!'.!?'.includes(text[i]!)) {
      continue
    }
    let end = i
    while (end + 1 < text.length && '.!?'.includes(text[end + 1]!)) {
      end++
    }
    if (end + 1 === text.length || /\s/.test(text[end + 1]!)) {
      const sentence = text.slice(start, end + 1).trim()
      if (sentence) {
        sentences.push(sentence)
      }
      start = end + 1
    }
    i = end
  }
  const tail = text.slice(start).trim()
  if (tail) {
    sentences.push(tail)
  }
  return sentences
}
