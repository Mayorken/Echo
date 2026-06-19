const fs = require('fs');
const path = require('path');
const { compileRegistry } = require('./compile-helper');

const { contract, warnings } = compileRegistry();

warnings.forEach((w) => console.warn(w));

console.log(' COMPILATION SUCCEEDED');
console.log('Functions in ABI:', contract.abi.filter(x => x.type === 'function').map(x => x.name).join(', '));
console.log('Bytecode size (bytes):', (contract.bytecode.length - 2) / 2);

fs.writeFileSync(
  path.join(__dirname, 'EchoMemoryRegistry.abi.json'),
  JSON.stringify(contract.abi, null, 2)
);
console.log('\nABI written to EchoMemoryRegistry.abi.json');
