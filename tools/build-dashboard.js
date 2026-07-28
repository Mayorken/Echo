const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const entryPath = path.join(root, 'frontend', 'privy.js');

esbuild.build({
  absWorkingDir: root,
  stdin: {
    contents: fs.readFileSync(entryPath, 'utf8'),
    resolveDir: root,
    sourcefile: 'frontend/privy.js',
  },
  outfile: path.join(root, 'privy.bundle.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  plugins: [{
    name: 'workspace-package-resolution',
    setup(build) {
      build.onResolve({ filter: /^@privy-io\/js-sdk-core$/ }, () => ({
        path: require.resolve('@privy-io/js-sdk-core'),
      }));
    },
  }],
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
