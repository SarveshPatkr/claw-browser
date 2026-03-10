import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['./node_modules/@novnc/novnc/lib/rfb.js'],
  bundle: true,
  outfile: './public/core/rfb-bundle.js',
  format: 'iife',
  globalName: 'RFB',
  platform: 'browser',
  target: ['es2020'],
  minify: false,
  sourcemap: true
});

console.log('Bundled noVNC to public/core/rfb-bundle.js');
