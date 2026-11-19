import { expect, it } from 'vitest'
import { condenseReplyForReadout } from './fallback-prose-extractor'

it.each([
  {
    label: 'short prose passes through',
    reply: 'The build passed. All 42 tests ran.',
    expected: 'The build passed. All 42 tests ran.'
  },
  {
    label: 'long prose keeps the first three sentences',
    reply: 'One. Two. Three. Four. Five.',
    expected: 'One. Two. Three.'
  },
  {
    label: 'a punctuation run ends one sentence',
    reply: 'What?! You shipped it. On a Friday. Bold. Reckless, even.',
    expected: 'What?! You shipped it. On a Friday.'
  },
  {
    label: 'code between prose is dropped',
    reply:
      'Here is the fix. It guards the null case. The test covers it. The rest is history.\n```ts\nconst answer = 42\n```\nDone.',
    expected: 'Here is the fix. It guards the null case. The test covers it.'
  },
  {
    label: 'a code-only reply reads as nothing',
    reply: '```ts\nconst answer = 42\n```',
    expected: ''
  },
  {
    label: 'an unclosed fence swallows the rest',
    reply: 'Begins here. ```ts\nnever closed',
    expected: 'Begins here.'
  },
  {
    label: 'a bullet list keeps the first three items',
    reply: '- Install the package\n- Run the build\n- Check the output\n- Ship it',
    expected: 'Install the package Run the build Check the output'
  },
  {
    label: 'a numbered list keeps the first three items',
    reply: '1. First step\n2. Second step\n3. Third step\n4. Fourth step',
    expected: 'First step Second step Third step'
  },
  {
    label: 'heading markers are stripped and headings count as a sentence',
    reply: '## Summary\nIt works. It is fast. Truly. Extra sentence.',
    expected: 'Summary It works. It is fast. Truly.'
  },
  {
    label: 'terminal-wrapped prose is joined, not split, at bare newlines',
    reply:
      'this is one long\nsentence that the terminal wrapped\npoorly. Second sentence here. Third. Fourth.',
    expected:
      'this is one long sentence that the terminal wrapped poorly. Second sentence here. Third.'
  },
  {
    label: 'paragraph breaks fall away once sentences are joined',
    reply: 'Alpha.\n\nBeta.',
    expected: 'Alpha. Beta.'
  },
  { label: 'blank input reads as nothing', reply: '   \n\t\n', expected: '' },
  { label: 'empty input reads as nothing', reply: '', expected: '' }
])('condenses $label', ({ reply, expected }) => {
  expect(condenseReplyForReadout(reply)).toBe(expected)
})
