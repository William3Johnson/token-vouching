require('babel-register');
require('babel-polyfill');

module.exports = {
  networks: {
    local: {
      host: 'localhost',
      port: 8545,
      network_id: '*',
      gas: 6700000,
      gasPrice: 2e9, // 2 Gwei
    },
    ropsten: {
      host: 'localhost',
      port: 8565,
      network_id: 3,
      gas: 500000,
      gasPrice: 10e9, // 10 Gwei
    },
    rinkeby: {
      host: 'localhost',
      port: 8565,
      network_id: 4,
      gas: 670000,
      gasPrice: 10e9, // 10 Gwei
    },
    kovan: {
      host: 'localhost',
      port: 8555,
      network_id: 42,
      gas: 2000000,
      gasPrice: 10e9, // 10 Gwei
    },
    mainnet: {
      host: 'localhost',
      port: 8545,
      network_id: '1',
      gas: 2600000,
      gasPrice: 10e9, // 10 Gwei
    }
  }
}
