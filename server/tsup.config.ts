import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'scripts/bootstrapAdmin': 'src/scripts/bootstrapAdmin.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // The shared workspace package ships TypeScript sources, so bundle it in.
  noExternal: ['@test-orbit/shared'],
  // Prisma's generated client must be loaded from node_modules at runtime (native engine + dynamic requires).
  external: ['@prisma/client', '.prisma/client'],
});
