const wasmBytes = await Bun.file(import.meta.dir + "/math.wasm.o").arrayBuffer();
const { instance } = await WebAssembly.instantiate(wasmBytes);
const { add } = instance.exports as { add: (a: number, b: number) => number };

console.log(add(2, 3)); // 5

