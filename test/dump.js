var fs = require('fs');
var elf = require('./vtable.js');

var Module = elf;

function toArrayBuffer(buffer) {
  var ab = new ArrayBuffer(buffer.length);
  var view = new Uint8Array(ab);
  for (var i = 0; i < buffer.length; ++i) {
    view[i] = buffer[i];
  }
  return ab;
}

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
  if (programInfo.rodataStart.high !== 0 || address.high !== 0 || size.high !== 0) {
    throw '>= 32-bit rodata is not supported';
  }

  for (var i = 0; i < programInfo.rodataChunks.size(); ++i) {
    var chunk = programInfo.rodataChunks.get(i);

    if (chunk.offset.high !== 0) {
      throw '>= 32-bit rodata is not supported';
    }

    var start = address.low - (programInfo.rodataStart.low + chunk.offset.low);
    var end = start + size.low;

    if (start < 0 || end > chunk.data.length) {
      continue;
    }

    return chunk.data.subarray(start, end);
  }

  return null;
}

function hex32(n) {
  return (n === 0) ? '00000000' : ('0000000' + ((n|0)+4294967296).toString(16)).substr(-8);
}

function hex64(n) {
  return hex32(n.high) + hex32(n.low);
}

function address(n, s) {
  if (s === 8 || n.high !== 0) {
    return hex64(n);
  } else {
    return hex32(n.low);
  }
}

function key(n) {
  return hex64(n);
}

function matches(a, b) {
  return a.low === b.low && a.high === b.high;
}

function isZero(n) {
  return n.low === 0 && n.high === 0;
}

if (process.argv.length <= 2) {
  throw 'Usage: ' + process.argv[0] + ' ' + process.argv[1] + ' <file>';
}

var inputFile = process.argv[2];

fs.readFile(inputFile, function(err, data) {
  if (err) {
    throw err;
  }

  var programInfo = elf.process(toArrayBuffer(data));
  if (programInfo.error.length > 0) {
    throw programInfo.error;
  }

  console.log("address size: " + programInfo.addressSize);
  console.log("symbols: " + programInfo.symbols.size());

  var out = {
    classes: [],
    functions: [],
  };

  var listOfVtables = [];
  var addressToSymbolMap = {};
  var addressToFunctionMap = {};

  for (var i = 0; i < programInfo.symbols.size(); ++i) {
    var symbol = programInfo.symbols.get(i);

    if (isZero(symbol.address) || isZero(symbol.size) || symbol.name.length === 0) {
      continue;
    }

    if (symbol.name.substr(0, 4) === '_ZTV') {
      listOfVtables.push(symbol);
    }

    addressToSymbolMap[key(symbol.address)] = symbol;
  }

  for (var vtableIndex = 0; vtableIndex < listOfVtables.length; ++vtableIndex) {
    var symbol = listOfVtables[vtableIndex];
    var name = cxa_demangle(symbol.name).substr(11);

    var data = getRodata(programInfo, symbol.address, symbol.size);
    if (!data) {
      console.log('VTable for ' + name + ' is outside .rodata');
      continue;
    }

    console.log('');
    console.log(name + ': ')

    var dataView = new Uint32Array(data.buffer, data.byteOffset, data.byteLength / Uint32Array.BYTES_PER_ELEMENT);
    for (var functionIndex = 0; functionIndex < dataView.length; ++functionIndex) {
      var functionAddress = {
        high: 0,
        low: dataView[functionIndex],
        unsigned: true,
      };

      if (programInfo.addressSize === 8) {
        functionAddress.high = dataView[++functionIndex];
      }

      var functionSymbol = addressToSymbolMap[key(functionAddress)];
      functionSymbol = functionSymbol && functionSymbol.name;

      var functionName = functionSymbol && cxa_demangle(functionSymbol);

      console.log('  ', address(functionAddress, programInfo.addressSize), functionName || '');
    }

    //break;
  }
});
