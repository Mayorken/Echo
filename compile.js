const solc = require('solc');
const fs = require('fs');
const path = require('path');

const contractPath = path.join(__dirname, 'contracts', 'EchoMemoryRegistry.sol');
const source = fs.readFileSync(contractPath, 'utf8');

const input = {
  language: 'Solidity',
  sources: {
    'EchoMemoryRegistry.sol': { content: source },
  },
  settings: {
    evmVersion: 'london',
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object'] },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

let hasError = false;
if (output.errors) {
  for (const err of output.errors) {
    if (err.severity === 'error') {
      hasError = true;
      console.error(err.formattedMessage);
    } else {
      console.warn(err.formattedMessage);
    }
  }
}

if (hasError) {
  console.error('\n COMPILATION FAILED');
  process.exit(1);
}

const compiled = output.contracts['EchoMemoryRegistry.sol']['EchoMemoryRegistry'];
console.log(' COMPILATION SUCCEEDED');
console.log('Functions in ABI:', compiled.abi.filter(x => x.type === 'function').map(x => x.name).join(', '));
console.log('Bytecode size (bytes):', compiled.evm.bytecode.object.length / 2);

fs.writeFileSync(
  path.join(__dirname, 'EchoMemoryRegistry.abi.json'),
  JSON.stringify(compiled.abi, null, 2)
);
console.log('\nABI written to EchoMemoryRegistry.abi.json');
