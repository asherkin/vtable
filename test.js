var fs = require('fs');
var elf = require('./vtable.js');

//console.log(elf, elf.process);

function BufferToUint8Array(buffer) {
  var ab = new ArrayBuffer(buffer.length);
  var view = new Uint8Array(ab);
  for (var i = 0; i < buffer.length; ++i) {
    view[i] = buffer[i];
  }
  return view;
}

function hex(n) {
  return ('0000000' + ((n|0)+4294967296).toString(16)).substr(-8);
}

fs.readFile('./server_srv.so', function(err, data) {
  if (err) {
    throw err;
  }

  var programInfo = elf.process(BufferToUint8Array(data));

  console.log("rodata offset: " + hex(programInfo.rodataOffset));
  console.log("rodata chunks: " + programInfo.rodataChunks.size());
  for (var i = 0; i < programInfo.rodataChunks.size(); ++i) {
    var chunk = programInfo.rodataChunks.get(i);
    console.log("  offset: " + hex(chunk.offset));
    console.log("    size: " + hex(chunk.data.size()));
  }

  console.log("symbols: " + programInfo.symbols.size());
  for (var i = 0; i < programInfo.symbols.size(); ++i) {
    var symbol = programInfo.symbols.get(i);
    console.log("  offset: " + hex(symbol.address));
    console.log("    size: " + hex(symbol.size));
    console.log("    name: " + symbol.name);
    if (i > 10) break;
  }
});
