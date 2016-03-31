var fs = require('fs');
var Module = require('../vtable.js');

function toArrayBuffer(buffer) {
  var arrayBuffer = new ArrayBuffer(buffer.length);

  var view = new Uint8Array(arrayBuffer);
  for (var i = 0; i < buffer.length; ++i) {
    view[i] = buffer[i];
  }

  return arrayBuffer;
}

function demangleSymbol(func) {
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
    console.error('Failed to demangle \'' + func + '\' (' + e.message + ')');
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

var loaded = 0;
var total = 0;
var lastProgressUpdate = 0;
function sendProgressUpdate(force) {
  var now = Date.now();
  if (!force && (now - lastProgressUpdate) < 50) {
    return;
  }

  //self.postMessage({ loaded: loaded, total: total });
  //console.info(loaded, total);
  lastProgressUpdate = now;
}

function hex32(n) {
  return (n === 0) ? '00000000' : ('0000000' + ((n|0)+4294967296).toString(16)).substr(-8);
}

function hex64(n) {
  return hex32(n.high) + hex32(n.low);
}

function key(n) {
  return hex64(n);
}

function isZero(n) {
  return n.low === 0 && n.high === 0;
}

//////////////////////////

function shouldSkipWindowsFunction(classInfo, vtableIndex, functionIndex, functionInfo) {
  return (
    functionInfo.name.indexOf('::~') !== -1
  ) ? (
    functionIndex > 0 &&
    functionInfo.name === classInfo.vtables[vtableIndex].functions[functionIndex - 1].name
  ) : (
    classInfo.vtables.find((d, n) => (
      n > vtableIndex &&
      d.functions.find((d) => (
        d.isThunk &&
        functionInfo.name === d.name
      ))
    ))
  );
}

//////////////////////////

if (process.argv.length <= 2) {
  throw 'Usage: ' + process.argv[0] + ' ' + process.argv[1] + ' <file>';
}

var inputFile = process.argv[2];

fs.readFile(inputFile, function(err, data) {
  if (err) {
    throw err;
  }

  var programInfo = Module['process'](toArrayBuffer(data));
  if (programInfo.error.length > 0) {
    throw programInfo.error;
  }

  console.info("address size: " + programInfo.addressSize);
  console.info("symbols: " + programInfo.symbols.size());

  var listOfVirtualClasses = [];
  var addressToSymbolMap = {};

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

  console.info("virtual classes: " + listOfVirtualClasses.length);

  var pureVirtualFunction = {
    id: null,
    name: '(pure virtual function)',
    symbol: null,
    searchKey: null,
    isThunk: false,
    classes: [],
  };

  var out = {
    classes: [],
    functions: [],
  };

  var addressToFunctionMap = {};

  total += listOfVirtualClasses.length;
  for (var classIndex = 0; classIndex < listOfVirtualClasses.length; ++classIndex) {
    loaded += 1;

    var symbol = listOfVirtualClasses[classIndex];
    var name = demangleSymbol(symbol.name).substr(11);

    var data = getRodata(programInfo, symbol.address, symbol.size);
    if (!data) {
      //console.warn('VTable for ' + name + ' is outside .rodata');
      sendProgressUpdate(false);
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
    total += dataView.length;
    for (var functionIndex = 0; functionIndex < dataView.length; ++functionIndex) {
      loaded += 1;

      var functionAddress = {
        high: 0,
        low: dataView[functionIndex],
        unsigned: true,
      };

      if (programInfo.addressSize > Uint32Array.BYTES_PER_ELEMENT) {
        functionAddress.high = dataView[++functionIndex];
        loaded += 1;
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
        var skip = programInfo.addressSize / Uint32Array.BYTES_PER_ELEMENT;
        functionIndex += skip;
        loaded += skip;

        sendProgressUpdate(false);
        continue;
      }

      var functionSymbol = functionSymbol && functionSymbol.name;
      if (!functionSymbol || functionSymbol === '__cxa_deleted_virtual' || functionSymbol === '__cxa_pure_virtual') {
        classInfo.hasMissingFunctions = true;
        currentVtable.push(pureVirtualFunction);

        sendProgressUpdate(false);
        continue;
      }

      var functionInfo = addressToFunctionMap[key(functionAddress)];
      if (!functionInfo) {
        var functionSignature = demangleSymbol(functionSymbol);

        var functionName = functionSignature;
        var startOfArgs = functionName.lastIndexOf('(');
        if (startOfArgs !== -1) {
          functionName = functionName.substr(0, startOfArgs);
        }

        var functionShortName = functionName;
        var startOfName = functionShortName.lastIndexOf('::');
        if (startOfName !== -1) {
          functionShortName = functionShortName.substr(startOfName + 2);
        }

        functionInfo = {
          id: key(functionAddress),
          name: functionSignature,
          symbol: functionSymbol,
          searchKey: functionName.toLowerCase(),
          shortName: functionShortName,
          isThunk: false,
          classes: [],
        };

        if (functionSymbol.substr(0, 4) !== '_ZTh') {
          out.functions.push(functionInfo);
        } else {
          functionInfo.isThunk = true;
          functionInfo.name = functionSignature.substr(21);
        }

        addressToFunctionMap[key(functionAddress)] = functionInfo;
      }

      functionInfo.classes.push(classInfo);
      currentVtable.push(functionInfo);

      sendProgressUpdate(false);
    }

    out.classes.push(classInfo);

    sendProgressUpdate(false);
  }

  sendProgressUpdate(true);
  //self.postMessage(out);

  //return;

  for (var classIndex = 0; classIndex < out.classes.length; ++classIndex) {
    var classInfo = out.classes[classIndex];

    console.log('');
    console.log('Class ' + classInfo.name);

    if (classInfo.hasMissingFunctions) {
      console.log('  Missing (pure or deleted) virtual functions');
    }
    if (classInfo.vtables.length > 1) {
      console.log('  Uses multiple inheritance');
    }
    if (classInfo.hasMissingFunctions || classInfo.vtables.length > 1) {
        console.log('  Windows offsets may be incorrect');
    }

    for (var vtableIndex = 0; vtableIndex < classInfo.vtables.length; ++vtableIndex) {
      var vtableInfo = classInfo.vtables[vtableIndex];

      console.log('  Table ' + vtableIndex + ' (thisoffs = ' + vtableInfo.offset + ')');
      console.log('    Lin Win Function');

      var windowsIndex = 0;
      for (var linuxIndex = 0; linuxIndex < vtableInfo.functions.length; ++linuxIndex) {
        var functionInfo = vtableInfo.functions[linuxIndex];

        var displayWindowsIndex = windowsIndex;
        if (shouldSkipWindowsFunction(classInfo, vtableIndex, linuxIndex, functionInfo)) {
          displayWindowsIndex = ' ';
        } else {
          if (functionInfo.symbol) {
            var previousOverloads = 0;
            var remainingOverloads = 0;

            while ((linuxIndex - (1 + previousOverloads)) >= 0) {
              var previousFunctionIndex = linuxIndex - (1 + previousOverloads);
              var previousFunctionInfo = vtableInfo.functions[previousFunctionIndex];

              if (!functionInfo.symbol || shouldSkipWindowsFunction(classInfo, vtableIndex, previousFunctionIndex, previousFunctionInfo)) {
                break;
              }

              if (functionInfo.shortName !== previousFunctionInfo.shortName) {
                break;
              }

              previousOverloads++;
            }

            while ((linuxIndex + 1 + remainingOverloads) < vtableInfo.functions.length) {
              var nextFunctionIndex = linuxIndex + 1 + remainingOverloads;
              var nextFunctionInfo = vtableInfo.functions[nextFunctionIndex];

              if (!functionInfo.symbol || shouldSkipWindowsFunction(classInfo, vtableIndex, nextFunctionIndex, nextFunctionInfo)) {
                break;
              }

              if (functionInfo.shortName !== nextFunctionInfo.shortName) {
                break;
              }

              remainingOverloads++;
            }

            displayWindowsIndex -= previousOverloads;
            displayWindowsIndex += remainingOverloads;
          }

          windowsIndex++;
        }

        console.log('    ' + ('  ' + linuxIndex).substr(-3) + ' ' + ('  ' + displayWindowsIndex).substr(-3) + ' ' + functionInfo.name);
      }
    }
  }
});
