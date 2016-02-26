var Module = {};
importScripts('vtable.js');

function cxa_demangle(func) {
  try {
    if (typeof func !== 'string') {
      throw new Error('input not a string');
    }
    var buf = Module['_malloc'](func.length + 1);
    Module['writeStringToMemory'](func, buf);
    var status = Module['_malloc'](4);
    var ret = Module['___cxa_demangle'](buf, 0, 0, status);
    var intStatus = Module['getValue'](status, 'i32');
    switch (intStatus) {
      case 0:
        if (!ret) {
          throw new Error('___cxa_demangle returned NULL');
        }
        return Module['Pointer_stringify'](ret);
      case -1:
        throw new Error('a memory allocation failiure occurred');
      case -2:
        throw new Error('input is not a valid name under the C++ ABI mangling rules');
      case -3:
        throw new Error('one of the arguments is invalid');
      default:
        throw new Error('encountered an unknown error');
    }
  } catch(e) {
    console.log('Failed to demangle \'' + func + '\' (' + e.message + ')');
    return func;
  } finally {
    if (buf) Module['_free'](buf);
    if (status) Module['_free'](status);
    if (ret) Module['_free'](ret);
  }
}

self.onmessage = (event) => {
  var programInfo = Module.process(event.data);

  var out = {
    error: programInfo.error,
  };

  if (out.error) {
    // Don't bother doing any more work.
    self.postMessage(programInfo);
  }

  var transferables = [];

  out.addressSize = programInfo.addressSize;
  out.rodataStart = programInfo.rodataStart;

  out.rodataChunks = [];
  for (var i = 0; i < programInfo.rodataChunks.size(); ++i) {
    var rodataChunk = programInfo.rodataChunks.get(i);

    transferables.push(rodataChunk.data.buffer);
    out.rodataChunks.push(rodataChunk);
  }

  out.symbols = [];
  for (var i = 0; i < programInfo.symbols.size(); ++i) {
    var symbol = programInfo.symbols.get(i);

    // Cut down on the amount of data we're sending over.
    if (symbol.address === 0 || symbol.size === 0 || symbol.name.length === 0 || symbol.name.substring(0, 2) !== '_Z') {
      continue;
    }

    symbol.demangled = cxa_demangle(symbol.name);

    out.symbols.push(symbol);
  }

  self.postMessage(out, transferables);
};
