import { describe, expect, it } from 'vitest'
import { mobileVersionLabel } from './about-version-label'

describe('mobileVersionLabel', () => {
  it('shows version and native build id', () => {
    expect(mobileVersionLabel({ version: '0.0.51', build: '18' })).toBe('v0.0.51 (18)')
  })

  it('drops the parens when the native build id is missing', () => {
    expect(mobileVersionLabel({ version: '0.0.51', build: '' })).toBe('v0.0.51')
  })

  it('names the personal build when the workflow baked one in, and stays plain otherwise', () => {
    expect(
      mobileVersionLabel({
        version: '0.0.51',
        build: '18',
        variant: 'dudupii/personal-1.4.197-dc3184fbd'
      })
    ).toBe('v0.0.51 (18) · dudupii/personal-1.4.197-dc3184fbd')
  })
})
