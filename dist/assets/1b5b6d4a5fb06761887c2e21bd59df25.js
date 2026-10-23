function f(e){return e.buffer instanceof ArrayBuffer&&e.byteOffset===0&&e.byteLength===e.buffer.byteLength?e.buffer:new Uint8Array(e).buffer}export{f as a};
