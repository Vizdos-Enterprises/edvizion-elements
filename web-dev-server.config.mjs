import { esbuildPlugin } from '@web/dev-server-esbuild';

export default {
  nodeResolve: true,
  watch: true,
  open: '/dev/',
  plugins: [
    esbuildPlugin({
      ts: true,
      target: 'es2022',
    }),
  ],
};
