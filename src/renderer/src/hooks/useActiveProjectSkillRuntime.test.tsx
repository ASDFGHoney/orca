// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '@/store'
import {
  hasLocalSkillRuntimeAuthority,
  resolveSkillExecutionHostPlatform,
  shouldUseLocalSkillFreshness,
  useActiveProjectSkillRuntime
} from './useActiveProjectSkillRuntime'

function setPlatform(platform: NodeJS.Platform): void {
  ;(window as unknown as { api: unknown }).api = {
    platform: { get: () => ({ platform }) }
  }
}

function setWindowsShell(terminalWindowsShell: string): void {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell }
  })
}

function setGlobalWslDefault(distro: string): void {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/tmp'),
      localWindowsRuntimeDefault: { kind: 'wsl', distro }
    }
  })
}

describe('useActiveProjectSkillRuntime', () => {
  beforeEach(() => {
    setPlatform('win32')
    setWindowsShell('git-bash')
    useAppStore.setState({
      runtimeEnvironmentCatalogSettled: true,
      runtimeEnvironments: [],
      runtimeStatusByEnvironmentId: new Map()
    })
  })

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  // Why: with no local project runtime, buildSkillCommandForRuntime still emits the
  // Windows host cmd.exe wrapper, which Git Bash would mangle into MSYS paths.
  it('still overrides a POSIX-family Windows shell when no project runtime resolves', () => {
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.projectRuntime).toBeUndefined()
    expect(result.current.terminalShellOverride).toBe('powershell.exe')
  })

  it('adopts the global WSL default when no project is active', () => {
    setGlobalWslDefault('Ubuntu')
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      label: 'WSL Ubuntu'
    })
  })

  it('ignores a windows-host global default so skill discovery keeps no target', () => {
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.projectRuntime).toBeUndefined()
    expect(result.current.discoveryTarget).toBeUndefined()
  })

  it('uses a remote Linux host instead of the Windows viewer platform', () => {
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        activeRuntimeEnvironmentId: 'linux-host'
      },
      runtimeEnvironments: [{ id: 'linux-host' }] as never,
      runtimeStatusByEnvironmentId: new Map([
        ['linux-host', { checkedAt: 1, status: { hostPlatform: 'linux' } as never }]
      ])
    })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toMatchObject({ runtime: 'host', hostPlatform: 'linux' })
    expect(result.current.terminalShellOverride).toBeUndefined()
  })

  it('uses a remote Windows host instead of the non-Windows viewer platform', () => {
    setPlatform('darwin')
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        activeRuntimeEnvironmentId: 'windows-host'
      },
      runtimeEnvironments: [{ id: 'windows-host' }] as never,
      runtimeStatusByEnvironmentId: new Map([
        ['windows-host', { checkedAt: 1, status: { hostPlatform: 'win32' } as never }]
      ])
    })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toMatchObject({ runtime: 'host', hostPlatform: 'win32' })
  })

  it('falls back to the viewer platform when an old remote host omits hostPlatform', () => {
    setPlatform('darwin')
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        activeRuntimeEnvironmentId: 'old-host'
      },
      runtimeEnvironments: [{ id: 'old-host' }] as never,
      runtimeStatusByEnvironmentId: new Map([['old-host', { checkedAt: 1, status: {} as never }]])
    })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toMatchObject({ runtime: 'host', hostPlatform: 'darwin' })
  })

  it('isolates the platform to the exact selected remote host', () => {
    expect(
      resolveSkillExecutionHostPlatform({
        viewerPlatform: 'darwin',
        runtimeTarget: { kind: 'environment', environmentId: 'linux-host' },
        executionHostPlatform: 'linux',
        isWebClient: false
      })
    ).toBe('linux')
    expect(
      resolveSkillExecutionHostPlatform({
        viewerPlatform: 'darwin',
        runtimeTarget: { kind: 'environment', environmentId: 'windows-host' },
        executionHostPlatform: 'win32',
        isWebClient: false
      })
    ).toBe('win32')
  })

  it('keeps local desktop behavior on the viewer platform', () => {
    expect(
      resolveSkillExecutionHostPlatform({
        viewerPlatform: 'darwin',
        runtimeTarget: { kind: 'local' },
        executionHostPlatform: 'linux',
        isWebClient: false
      })
    ).toBe('darwin')
  })

  it('uses the paired web host platform instead of the viewer platform', () => {
    expect(
      resolveSkillExecutionHostPlatform({
        viewerPlatform: 'win32',
        runtimeTarget: { kind: 'local' },
        executionHostPlatform: 'linux',
        isWebClient: true
      })
    ).toBe('linux')
  })

  it('does not adopt the global default once a project is active', () => {
    setGlobalWslDefault('Ubuntu')
    useAppStore.setState({ activeRepoId: 'repo-1' })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toBeUndefined()
    useAppStore.setState({ activeRepoId: null })
  })

  it('does not inject the local WSL runtime or shell into a remote environment', () => {
    setGlobalWslDefault('Ubuntu')
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        activeRuntimeEnvironmentId: 'ssh-production'
      },
      runtimeEnvironments: [{ id: 'ssh-production' }] as never
    })
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.agentRuntime).toMatchObject({ runtime: 'host', hostPlatform: 'win32' })
    expect(result.current.terminalShellOverride).toBeUndefined()
  })

  it('leaves the shell alone on non-Windows hosts', () => {
    setPlatform('darwin')
    const { result } = renderHook(() => useActiveProjectSkillRuntime())

    expect(result.current.terminalShellOverride).toBeUndefined()
  })

  it('limits local freshness to resolved host runtimes', () => {
    expect(shouldUseLocalSkillFreshness({ kind: 'local' }, undefined)).toBe(true)
    expect(
      shouldUseLocalSkillFreshness({ kind: 'local' }, { runtime: 'host', label: 'Host' })
    ).toBe(true)
    expect(shouldUseLocalSkillFreshness({ kind: 'local' }, { runtime: 'wsl', label: 'WSL' })).toBe(
      false
    )
    expect(
      shouldUseLocalSkillFreshness(
        { kind: 'environment', environmentId: 'ssh-production' },
        undefined
      )
    ).toBe(false)
    expect(shouldUseLocalSkillFreshness(null, undefined)).toBe(false)
  })

  it('limits the no-project Windows fallback to local runtime authority', () => {
    expect(hasLocalSkillRuntimeAuthority({ kind: 'local' })).toBe(true)
    expect(
      hasLocalSkillRuntimeAuthority({ kind: 'environment', environmentId: 'ssh-production' })
    ).toBe(false)
    expect(hasLocalSkillRuntimeAuthority(null)).toBe(false)
  })
})
