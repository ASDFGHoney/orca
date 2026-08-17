import { describe, expect, it } from 'vitest'
import {
  getRemoteBrowserPointerCommands,
  type RemoteBrowserPointerSample
} from './remote-browser-pointer-gesture'

const start: RemoteBrowserPointerSample = {
  pointerId: 7,
  x: 100,
  y: 200,
  button: 'left',
  modifiers: ['cmd']
}

describe('remote browser pointer gesture', () => {
  it('routes a click through the atomic opcode supported by legacy hosts', () => {
    expect(getRemoteBrowserPointerCommands(start, { pointerId: 7, x: 100, y: 200 })).toEqual([
      {
        method: 'browser.mouseClick',
        params: { x: 100, y: 200, button: 'left', modifiers: ['cmd'] }
      }
    ])
  })

  it('keeps small physical pointer jitter on the atomic click path', () => {
    expect(getRemoteBrowserPointerCommands(start, { pointerId: 7, x: 104, y: 204 })).toEqual([
      {
        method: 'browser.mouseClick',
        params: { x: 104, y: 204, button: 'left', modifiers: ['cmd'] }
      }
    ])
  })

  it('preserves the existing remote drag sequence', () => {
    expect(getRemoteBrowserPointerCommands(start, { pointerId: 7, x: 140, y: 250 })).toEqual([
      { method: 'browser.mouseMove', params: { x: 100, y: 200 } },
      { method: 'browser.mouseDown', params: { button: 'left' } },
      { method: 'browser.mouseMove', params: { x: 140, y: 250 } },
      { method: 'browser.mouseUp', params: { button: 'left' } }
    ])
  })

  it('rejects a pointer-up from a different gesture', () => {
    expect(getRemoteBrowserPointerCommands(start, { pointerId: 8, x: 100, y: 200 })).toBeNull()
  })
})
