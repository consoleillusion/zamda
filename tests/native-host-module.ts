// A host module for worker tests: the engine as the native library, made inside the worker.
import { nativeHost } from './engine-host';

export default async function make() {
  // Purpose: the native engine host, or null if the library is not built
  return nativeHost();
}
