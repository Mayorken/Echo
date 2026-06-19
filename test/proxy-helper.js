const { ethers } = require('ethers');
const { compileProxy } = require('../compile-helper');

let proxyArtifact;

/**
 * Deploy an EchoMemoryRegistry (or V2) behind an ERC1967Proxy.
 * Returns the contract instance attached to the proxy address.
 *
 * @param {object} implArtifact { abi, bytecode } of the implementation
 * @param {ethers.Signer} deployer Signer that becomes the contract owner
 * @returns {Promise<ethers.Contract>} Contract instance at the proxy address
 */
async function deployProxy(implArtifact, deployer) {
  if (!proxyArtifact) proxyArtifact = compileProxy();

  const implFactory = new ethers.ContractFactory(
    implArtifact.abi,
    implArtifact.bytecode,
    deployer
  );
  const impl = await implFactory.deploy();
  await impl.waitForDeployment();

  const initData = impl.interface.encodeFunctionData('initialize', [
    await deployer.getAddress(),
  ]);

  const proxyFactory = new ethers.ContractFactory(
    proxyArtifact.abi,
    proxyArtifact.bytecode,
    deployer
  );
  const proxy = await proxyFactory.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();

  return new ethers.Contract(
    await proxy.getAddress(),
    implArtifact.abi,
    deployer
  );
}

module.exports = { deployProxy };
