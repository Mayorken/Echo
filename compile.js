const fs = require('fs');
const path = require('path');
const { compileAll } = require('./compile-helper');

const contracts = compileAll();

// Use V3 ABI (superset of V1+V2+V3 functions) so the SDK works against any
// version of the proxy — V3 ABI is backwards-compatible with older deployments.
const compiled = contracts.EchoMemoryRegistryV3 || contracts.EchoMemoryRegistry;
const label = contracts.EchoMemoryRegistryV3 ? 'EchoMemoryRegistryV3' : 'EchoMemoryRegistry';

console.log(` COMPILATION SUCCEEDED (${label})`);
console.log('Functions in ABI:', compiled.abi.filter(x => x.type === 'function').map(x => x.name).join(', '));
console.log('Bytecode size (bytes):', (compiled.bytecode.length - 2) / 2);

fs.writeFileSync(
  path.join(__dirname, 'EchoMemoryRegistry.abi.json'),
  JSON.stringify(compiled.abi, null, 2)
);
console.log('\nABI written to EchoMemoryRegistry.abi.json');
