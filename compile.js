const fs = require('fs');
const path = require('path');
const { compileAll } = require('./compile-helper');

const contracts = compileAll();
const compiled = contracts.EchoMemoryRegistry;

console.log(' COMPILATION SUCCEEDED');
console.log('Functions in ABI:', compiled.abi.filter(x => x.type === 'function').map(x => x.name).join(', '));
console.log('Bytecode size (bytes):', (compiled.bytecode.length - 2) / 2);

fs.writeFileSync(
  path.join(__dirname, 'EchoMemoryRegistry.abi.json'),
  JSON.stringify(compiled.abi, null, 2)
);
console.log('\nABI written to EchoMemoryRegistry.abi.json');
