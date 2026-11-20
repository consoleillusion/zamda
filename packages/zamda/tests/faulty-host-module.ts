// A host module for worker tests: the first engine made anywhere traps on its first run step (as a WASM module
// would on `unreachable`); every engine after that is healthy. "First anywhere" is a marker file named by
// the marker file path given as the factory argument (`hostArg`), because a replacement worker loads this module afresh and could not otherwise tell.
import { existsSync, writeFileSync } from 'node:fs';
import { nativeHost } from './engine-host';

let made = 0;

function firstEverMade(marker: string | undefined): boolean {
  // Purpose: true only for the first engine made under this marker file (in any worker)
  if (marker === undefined) return made++ === 0;
  if (existsSync(marker)) return false;
  writeFileSync(marker, 'made');
  return true;
}

export default async function make(marker?: string) {
  // Purpose: a host that traps once, then healthy hosts
  const base = nativeHost();
  if (base === null || !firstEverMade(marker)) return base;
  return new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'runStep') {
        return () => {
          throw new WebAssembly.RuntimeError('unreachable');
        };
      }
      return value;
    },
  });
}
