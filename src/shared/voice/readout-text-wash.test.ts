import { expect, it } from 'vitest'
import { washReadoutText } from './readout-text-wash'

it.each([
  {
    label: 'plain prose passes through untouched',
    text: 'It is noon. Grab an umbrella. Rain is likely.',
    lang: null,
    expected: 'It is noon. Grab an umbrella. Rain is likely.'
  },
  {
    label: 'bold markers peel off',
    text: '**Done** and shipped.',
    lang: null,
    expected: 'Done and shipped.'
  },
  {
    label: 'italic markers peel off',
    text: 'The build is *fast* now.',
    lang: null,
    expected: 'The build is fast now.'
  },
  {
    label: 'bold-italic peels in one pass',
    text: '***both*** markers.',
    lang: null,
    expected: 'both markers.'
  },
  {
    label: 'inline code keeps its content, drops its ticks',
    text: 'Run `pnpm build` first.',
    lang: null,
    expected: 'Run pnpm build first.'
  },
  {
    label: 'a labeled link keeps its readable text and drops the URL',
    text: '清单在 [评论线程](https://github.com/dudupii/orca/issues/50) 里。',
    lang: null,
    expected: '清单在 评论线程 里。'
  },
  {
    label: 'a short bare URL reads as its domain',
    text: 'Docs live at https://example.com.',
    lang: null,
    expected: 'Docs live at example.com.'
  },
  {
    label: 'a short bare URL drops its www and trailing slash',
    text: 'Docs live at https://www.example.com/ now.',
    lang: null,
    expected: 'Docs live at example.com now.'
  },
  {
    label: 'a deep URL with a comment anchor is skipped whole',
    text: 'Details at https://github.com/dudupii/orca/pull/27#issuecomment-7086648152.',
    lang: null,
    expected: 'Details at.'
  },
  {
    label: 'a deep URL with a query is skipped whole',
    text: 'See https://example.com/search?q=build for notes.',
    lang: null,
    expected: 'See for notes.'
  },
  {
    label: 'an issue reference expands in the spoken language',
    text: 'See #50 for the checklist.',
    lang: 'en-US',
    expected: 'See issue 50 for the checklist.'
  },
  {
    label: 'an issue reference expands in Chinese when the readout is spoken in Chinese',
    text: '清单见 #50。',
    lang: 'zh-CN',
    expected: '清单见 50 号问题。'
  },
  {
    label: 'an issue reference expands in Japanese when the readout is spoken in Japanese',
    text: 'リストは #50 を見て。',
    lang: 'ja-JP',
    expected: 'リストは イシュー50 を見て。'
  },
  {
    label: 'without a locale, Chinese prose expands the reference in Chinese',
    text: '清单见 #50。',
    lang: null,
    expected: '清单见 50 号问题。'
  },
  {
    label: 'without a locale, Japanese prose expands the reference in Japanese',
    text: 'リストは #50 を見て。',
    lang: null,
    expected: 'リストは イシュー50 を見て。'
  },
  {
    label: 'without a locale, Latin prose expands the reference as an issue',
    text: 'See #50 for the checklist.',
    lang: null,
    expected: 'See issue 50 for the checklist.'
  },
  {
    label: 'heading markers and hex colors with letters are not issue references',
    text: '## Notes\nThe palette is #ffcc00 today.',
    lang: null,
    expected: '## Notes\nThe palette is #ffcc00 today.'
  },
  {
    label: 'mixed Chinese and English prose washes as one piece',
    text: '修好了 **登录** 问题,详见 #50 和 https://github.com/dudupii/orca/issues/50#issuecomment-1。',
    lang: null,
    expected: '修好了 登录 问题,详见 50 号问题 和。'
  },
  {
    label: 'doubled blanks left by dropped URLs collapse away',
    text: 'Pinned at https://x.dev/a/b#f and merged.',
    lang: null,
    expected: 'Pinned at and merged.'
  },
  {
    label: 'a readout that is only a deep URL washes to nothing',
    text: 'https://github.com/dudupii/orca/pull/27#issuecomment-7086648152',
    lang: null,
    expected: ''
  },
  {
    label: 'empty input washes to nothing',
    text: '',
    lang: 'zh-CN',
    expected: ''
  }
])('washes $label', ({ text, lang, expected }) => {
  expect(washReadoutText(text, lang)).toBe(expected)
})

it('the screenshot readout arrives spoken-clean: no markers, no link syntax, no URL, a natural reference', () => {
  const washed = washReadoutText(
    '**登录修复已合并** [#50 评论里的清单](https://github.com/dudupii/orca/issues/50#issuecomment-7086648152) 已核对。',
    'zh-CN'
  )
  expect(washed).not.toContain('**')
  expect(washed).not.toMatch(/\[[^\]]*\]\(/)
  expect(washed).not.toMatch(/https?:\/\//)
  expect(washed).toContain('50 号问题')
  expect(washed).toContain('评论里的清单')
  expect(washed).toBe('登录修复已合并 50 号问题 评论里的清单 已核对。')
})
