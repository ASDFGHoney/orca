// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { isPortaledRowMenuClick, isRowActivationKey } from './artifact-list-row-interaction'

describe('artifact list row interaction', () => {
  it('treats clicks from outside the row as portaled menu clicks', () => {
    const row = document.createElement('div')
    const menu = document.createElement('div')
    document.body.append(row, menu)
    expect(isPortaledRowMenuClick({ target: menu, currentTarget: row })).toBe(true)
    expect(isPortaledRowMenuClick({ target: row, currentTarget: row })).toBe(false)
  })

  it('activates only when Enter or Space lands on the row itself', () => {
    const row = document.createElement('div')
    const nested = document.createElement('button')
    row.append(nested)
    expect(isRowActivationKey({ key: 'Enter', target: row, currentTarget: row })).toBe(true)
    expect(isRowActivationKey({ key: ' ', target: row, currentTarget: row })).toBe(true)
    expect(isRowActivationKey({ key: 'Enter', target: nested, currentTarget: row })).toBe(false)
    expect(isRowActivationKey({ key: 'Tab', target: row, currentTarget: row })).toBe(false)
  })
})
