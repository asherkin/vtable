var fs = require('fs');
var elf = require('../vtable.js');

var Module = elf;

function toArrayBuffer(buffer) {
  var ab = new ArrayBuffer(buffer.length);
  var view = new Uint8Array(ab);
  for (var i = 0; i < buffer.length; ++i) {
    view[i] = buffer[i];
  }
  return ab;
}

function demangleSymbol(func) {
  try {
    if (typeof func !== 'string') {
      //throw new Error('input not a string');
      return func;
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

  var listOfVirtualClasses = [];
  var addressToSymbolMap = {};
  var addressToFunctionMap = {};

  for (var i = 0; i < programInfo.symbols.size(); ++i) {
    var symbol = programInfo.symbols.get(i);

    if (isZero(symbol.address) || isZero(symbol.size) || symbol.name.length === 0) {
      continue;
    }

    if (symbol.name.substr(0, 4) === '_ZTV') {
      listOfVirtualClasses.push(symbol);
    }

    addressToSymbolMap[key(symbol.address)] = symbol;
  }

  for (var classIndex = 0; classIndex < listOfVirtualClasses.length; ++classIndex) {
    var symbol = listOfVirtualClasses[classIndex];
    var name = demangleSymbol(symbol.name).substr(11);

    var data = getRodata(programInfo, symbol.address, symbol.size);
    if (!data) {
      console.log('VTable for ' + name + ' is outside .rodata');
      continue;
    }

    var currentVtable;
    var vtables = [];

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

      // This could be the end of the vtable, or it could just be a pure/deleted func.
      if (!functionSymbol && (vtables.length === 0 || !isZero(functionAddress))) {
        currentVtable = [];
        vtables.push({ offset: functionAddress, functions: currentVtable});

        // Skip the RTTI pointer and thisptr adjuster,
        // We'll need to do more work here for virtual bases.
        functionIndex += (programInfo.addressSize / 4);

        continue;
      }

      functionSymbol = functionSymbol && functionSymbol.name;
      currentVtable.push({ address: address(functionAddress, programInfo.addressSize), symbol: functionSymbol });
    }

    //console.log(name, vtables);
    console.log('');
    console.log('Class ' + name);
    for (var i = 0; i < vtables.length; ++i) {
      console.log('  Table ' + i + ' (thisoffs = ' + ~(vtables[i].offset.low - 1) + ')');
      console.log('    Lin Win Function');
      windowsIndex = 0;
      for (var j = 0; j < vtables[i].functions.length; ++j) {
        var symbol = vtables[i].functions[j].symbol;
        var displayName = demangleSymbol(symbol);

        if (symbol === '__cxa_deleted_virtual' || symbol === '__cxa_pure_virtual') {
          symbol = displayName = undefined;
        }

        var displayWindowsIndex = windowsIndex;

        var isDestructor = displayName && displayName.indexOf('::~') !== -1;
        var isFirstDestructor = isDestructor && (j + 1) < vtables[i].functions.length && displayName === demangleSymbol(vtables[i].functions[j + 1].symbol);
        var isSecondDestructor = isDestructor && (j > 0 && displayName === demangleSymbol(vtables[i].functions[j - 1].symbol));
        var isMultipleInheritanceFunc = !isDestructor && (i === 0 && vtables.find((d, n) => (n !== 0) && d.functions.find((d) => d.symbol && d.symbol.substr(0, 4) === '_ZTh' && displayName === demangleSymbol(d.symbol).substr(21))))

        if (isSecondDestructor || isMultipleInheritanceFunc) {
          displayWindowsIndex = ' ';
        } else {
          if (displayName && !isFirstDestructor) {
            var previousOverloads = 0;
            var remainingOverloads = 0;

            var functionName = displayName;
            var startOfArgs = functionName.lastIndexOf('(');
            if (startOfArgs !== -1) {
              functionName = functionName.substr(0, startOfArgs);
            }

            while ((j - (1 + previousOverloads)) >= 0) {
              var previousFunctionName = vtables[i].functions[(j - (1 + previousOverloads))].symbol;
              if (!previousFunctionName) {
                break;
              }

              previousFunctionName = demangleSymbol(previousFunctionName);
              var startOfArgs = previousFunctionName.lastIndexOf('(');
              if (startOfArgs !== -1) {
                previousFunctionName = previousFunctionName.substr(0, startOfArgs);
              }

              if (functionName !== previousFunctionName) {
                break;
              }

              previousOverloads++;
            }

            while ((j + 1 + remainingOverloads) < vtables[i].functions.length) {
              var nextFunctionName = vtables[i].functions[(j + 1 + remainingOverloads)].symbol;
              if (!nextFunctionName) {
                break;
              }

              nextFunctionName = demangleSymbol(nextFunctionName);
              var startOfArgs = nextFunctionName.lastIndexOf('(');
              if (startOfArgs !== -1) {
                nextFunctionName = nextFunctionName.substr(0, startOfArgs);
              }

              if (functionName !== nextFunctionName) {
                break;
              }

              remainingOverloads++;
            }

            displayWindowsIndex += remainingOverloads;
            displayWindowsIndex -= previousOverloads;
          }

          windowsIndex++;
        }

        if (symbol && symbol.substr(0, 4) === '_ZTh') {
          displayName = displayName.substr(21);
        }

        if (!displayName) {
          displayName = '(pure virtual function)';
        }

        console.log('    ' + ('  ' + j).substr(-3) + ' ' + ('  ' + displayWindowsIndex).substr(-3) + ' ' + displayName);
      }
    }
  }
});
