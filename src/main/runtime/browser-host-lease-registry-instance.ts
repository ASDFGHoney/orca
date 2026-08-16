import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'

const registries = new WeakMap<object, BrowserHostLeaseRegistry>()

export function getBrowserHostLeaseRegistry(runtime: {
  getRuntimeId(): string
}): BrowserHostLeaseRegistry {
  let registry = registries.get(runtime)
  if (!registry) {
    registry = new BrowserHostLeaseRegistry({ authorityRuntimeId: runtime.getRuntimeId() })
    registries.set(runtime, registry)
  }
  return registry
}
