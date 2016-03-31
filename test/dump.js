var fs = require('fs');
var elf = require('../vtable.js');

var Module = elf;

function toArrayBuffer(buffer) {
  var arrayBuffer = new ArrayBuffer(buffer.length);

  var view = new Uint8Array(arrayBuffer);
  for (var i = 0; i < buffer.length; ++i) {
    view[i] = buffer[i];
  }

  return arrayBuffer;
}

function demangleSymbol(func) {
  if (func === null) {
    return null;
  }

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

function shouldSkipWindowsFunction(classInfo, vtableIndex, linuxIndex, displayName) {
  return (
    displayName &&
    displayName.indexOf('::~') !== -1
  ) ? (
    linuxIndex > 0 &&
    displayName === demangleSymbol(classInfo.vtables[vtableIndex].functions[linuxIndex - 1].symbol)
  ) : (
    vtableIndex === 0 &&
    classInfo.vtables.find((d, n) => (
      n !== 0 &&
      d.functions.find((d) => (
        d.symbol &&
        d.symbol.substr(0, 4) === '_ZTh' &&
        displayName === demangleSymbol(d.symbol).substr(21)
      ))
    ))
  );
}

function getFunctionName(demangledName, withNamespace) {
  var functionName = demangledName;

  var startOfArgs = functionName.lastIndexOf('(');
  if (startOfArgs !== -1) {
    functionName = functionName.substr(0, startOfArgs);
  }

  if (!withNamespace) {
    var startOfName = functionName.lastIndexOf('::');
    if (startOfName !== -1) {
      functionName = functionName.substr(startOfName + 2);
    }
  }

  return functionName;
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

  var pureVirtualFunction = {
    id: null,
    name: null,
    symbol: null,
    searchKey: null,
    classes: [],
  };

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
      //console.log('VTable for ' + name + ' is outside .rodata');
      continue;
    }

    var classInfo = {
      id: key(symbol.address),
      name: name,
      searchKey: name.toLowerCase(),
      vtables: [],
      hasMissingFunctions: false,
    };

    var currentVtable;
    var dataView = new Uint32Array(data.buffer, data.byteOffset, data.byteLength / Uint32Array.BYTES_PER_ELEMENT);
    for (var functionIndex = 0; functionIndex < dataView.length; ++functionIndex) {
      var functionAddress = {
        high: 0,
        low: dataView[functionIndex],
        unsigned: true,
      };

      if (programInfo.addressSize > Uint32Array.BYTES_PER_ELEMENT) {
        functionAddress.high = dataView[++functionIndex];
      }

      var functionSymbol = addressToSymbolMap[key(functionAddress)];

      // This could be the end of the vtable, or it could just be a pure/deleted func.
      if (!functionSymbol && (classInfo.vtables.length === 0 || !isZero(functionAddress))) {
        currentVtable = [];
        classInfo.vtables.push({
          offset: ~(functionAddress.low - 1),
          functions: currentVtable,
        });

        // Skip the RTTI pointer and thisptr adjuster,
        // We'll need to do more work here for virtual bases.
        functionIndex += (programInfo.addressSize / Uint32Array.BYTES_PER_ELEMENT);
        continue;
      }

      var functionSymbol = functionSymbol && functionSymbol.name;
      if (!functionSymbol || functionSymbol === '__cxa_deleted_virtual' || functionSymbol === '__cxa_pure_virtual') {
        classInfo.hasMissingFunctions = true;
        currentVtable.push(pureVirtualFunction);
        continue;
      }

      var functionInfo = addressToFunctionMap[key(functionAddress)];
      if (!functionInfo) {
        var functionName = demangleSymbol(functionSymbol);
        functionInfo = {
          id: key(functionAddress),
          name: functionName,
          symbol: functionSymbol,
          searchKey: getFunctionName(functionName, true).toLowerCase(),
          classes: [],
        };

        if (functionSymbol.substr(0, 4) !== '_ZTh') {
          out.functions.push(functionInfo);
        }

        addressToFunctionMap[key(functionAddress)] = functionInfo;
      }

      functionInfo.classes.push(classInfo);
      currentVtable.push(functionInfo);
    }

    out.classes.push(classInfo);
  }

  for (var classIndex = 0; classIndex < out.classes.length; ++classIndex) {
    var classInfo = out.classes[classIndex];

    console.log('');
    console.log('Class ' + classInfo.name);

    if (classInfo.hasMissingFunctions) {
      console.log('  Missing (pure or deleted) virtual functions,');
      console.log('  Windows offsets may be incorrect for overloaded functions.');
    }

    for (var vtableIndex = 0; vtableIndex < classInfo.vtables.length; ++vtableIndex) {
      var vtableInfo = classInfo.vtables[vtableIndex];

      console.log('  Table ' + vtableIndex + ' (thisoffs = ' + vtableInfo.offset + ')');
      console.log('    Lin Win Function');

      windowsIndex = 0;
      for (var linuxIndex = 0; linuxIndex < vtableInfo.functions.length; ++linuxIndex) {
        var symbol = vtableInfo.functions[linuxIndex].symbol;
        var displayName = demangleSymbol(symbol);

        var displayWindowsIndex = windowsIndex;
        if (shouldSkipWindowsFunction(classInfo, vtableIndex, linuxIndex, displayName)) {
          displayWindowsIndex = ' ';
        } else {
          if (displayName) {
            var previousOverloads = 0;
            var remainingOverloads = 0;

            var functionName = getFunctionName(displayName, false);

            while ((linuxIndex - (1 + previousOverloads)) >= 0) {
              var previousFunctionIndex = linuxIndex - (1 + previousOverloads);
              var previousFunctionName = vtableInfo.functions[previousFunctionIndex].symbol;
              if (!previousFunctionName) {
                break;
              }

              previousFunctionName = demangleSymbol(previousFunctionName);
              if (shouldSkipWindowsFunction(classInfo, vtableIndex, previousFunctionIndex, previousFunctionName)) {
                break;
              }

              previousFunctionName = getFunctionName(previousFunctionName, false);
              if (functionName !== previousFunctionName) {
                break;
              }

              previousOverloads++;
            }

            while ((linuxIndex + 1 + remainingOverloads) < vtableInfo.functions.length) {
              var nextFunctionIndex = linuxIndex + 1 + remainingOverloads;
              var nextFunctionName = vtableInfo.functions[nextFunctionIndex].symbol;
              if (!nextFunctionName) {
                break;
              }

              nextFunctionName = demangleSymbol(nextFunctionName);
              if (shouldSkipWindowsFunction(classInfo, vtableIndex, nextFunctionIndex, nextFunctionName)) {
                break;
              }

              nextFunctionName = getFunctionName(nextFunctionName, false);
              if (functionName !== nextFunctionName) {
                break;
              }

              remainingOverloads++;
            }

            displayWindowsIndex -= previousOverloads;
            displayWindowsIndex += remainingOverloads;
          }

          windowsIndex++;
        }

        if (symbol && symbol.substr(0, 4) === '_ZTh') {
          displayName = displayName.substr(21);
        }

        if (!displayName) {
          displayName = '(pure virtual function)';
        }

        console.log('    ' + ('  ' + linuxIndex).substr(-3) + ' ' + ('  ' + displayWindowsIndex).substr(-3) + ' ' + displayName);
      }
    }
  }
});
