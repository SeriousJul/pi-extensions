/**
 * The default Index factory registry (spec 0003).
 *
 * A session constructed without an injected factory resolves the factory
 * registered here. handlers.ts registers the real factory at module load,
 * so the session's synchronous entry points (statusFor, isReadyFor) work
 * without waiting for the first async use. This module is library-free on
 * purpose: importing it never loads the codegraph library.
 */
import type { IndexAdapterFactory } from "./indexAdapter";

let defaultFactory: IndexAdapterFactory | undefined;

/** Register the factory a factory-less session may resolve to. */
export function setDefaultIndexFactory(factory: IndexAdapterFactory): void {
  defaultFactory = factory;
}

/** The registered default factory, or undefined when nothing has registered one. */
export function getDefaultIndexFactory(): IndexAdapterFactory | undefined {
  return defaultFactory;
}
