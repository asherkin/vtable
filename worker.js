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

function getRodata(programInfo, address, size) {
  for (var i = 0; i < programInfo.rodataChunks.size(); ++i) {
    var chunk = programInfo.rodataChunks.get(i);

    var start = address - (programInfo.rodataStart + chunk.offset);
    var end = start + size;

    if (start < 0 || end >= chunk.data.length) {
      continue;
    }

    return chunk.data.subarray(start, end);
  }

  return null;
}

self.onmessage = function(event) {
  var programInfo = Module.process(event.data);

  if (programInfo.error.length > 0) {
    // Don't bother doing any more work.
    self.postMessage({ error: programInfo.error });
    return;
  }

  var listOfVtables = [];
  var addresToSymbolMap = {};

  for (var i = 0; i < programInfo.symbols.size(); ++i) {
    var symbol = programInfo.symbols.get(i);

    if (symbol.address === 0 || symbol.size === 0 || symbol.name.length === 0) {
      continue;
    }

    if (symbol.name.substring(0, 4) === '_ZTV') {
      listOfVtables.push(symbol);
    }

    addresToSymbolMap[symbol.address] = symbol.name;
  }

  var out = {
    classes: [],
    functions: [],
  };

  var addressToFunctionMap = {};

  var loaded = 0;
  var total = 0;
  var lastSend = 0;

  var vtableCount = listOfVtables.length;
  total += vtableCount;

  for (var vtableIndex = 0; vtableIndex < vtableCount; ++vtableIndex) {
    loaded += 1;

    var symbol = listOfVtables[vtableIndex];
    var name = cxa_demangle(symbol.name).substr(11);

    var data = getRodata(programInfo, symbol.address, symbol.size);
    if (!data) {
      var now = Date.now();
      if (now - lastSend > 100) {
        self.postMessage({ loaded: loaded, total: total });
        lastSend = now;
      }

      //console.log('VTable for ' + name + ' is outside .rodata');
      continue;
    }

    var dataView = new Uint32Array(data.buffer, data.byteOffset, data.byteLength / Uint32Array.BYTES_PER_ELEMENT);

    var classInfo = {
      name: name,
      address: symbol.address,
      searchKey: name.toLowerCase(),
      functions: [],
    };

    var functionCount = dataView.length;
    total += functionCount - 2;

    for (var functionIndex = 2; functionIndex < functionCount; ++functionIndex) {
      var functionAddress = dataView[functionIndex];
      var functionSymbol = addresToSymbolMap[functionAddress];

      // Pure virtual.
      if (functionAddress === 0 || functionSymbol === '__cxa_pure_virtual') {
        // Pad to correct the indexes.
        classInfo.functions.push({});
        loaded += 1;
        continue;
      }

      // End of primary vtable.
      if (!functionSymbol) {
        loaded += functionCount - functionIndex;
        break;
      }

      var functionName = cxa_demangle(functionSymbol);

      var functionInfo = addressToFunctionMap[functionAddress];
      if (!functionInfo) {
        var searchKey = functionName.toLowerCase();

        var startOfArgs = functionName.lastIndexOf('(');
        if (startOfArgs !== -1) {
          searchKey = searchKey.substr(0, startOfArgs);
        }

        functionInfo = addressToFunctionMap[functionAddress] = {
          name: functionName,
          address: functionAddress,
          searchKey: searchKey,
          classes: [],
        };

        out.functions.push(functionInfo);
      }

      functionInfo.classes.push(classInfo);
      classInfo.functions.push(functionInfo);

      loaded += 1;

      var now = Date.now();
      if (now - lastSend > 100) {
        self.postMessage({ loaded: loaded, total: total });
        lastSend = now;
      }
    }

    out.classes.push(classInfo);
  }

  self.postMessage({ loaded: loaded, total: total });
  self.postMessage(out);
};
