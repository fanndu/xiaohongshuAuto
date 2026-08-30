import { defineConfig } from 'wxt';

export default defineConfig({
  manifestVersion: 3,
  vite: () => ({
    build: {
      minify: 'esbuild',
    },
    esbuild: {
      // Chromium rejects otherwise well-formed UTF-8 scripts when a bundled
      // dependency contains Unicode noncharacters such as U+10FFFF.
      charset: 'ascii',
    },
  }),
  manifest: {
    name: '小红书个人资料采集器',
    description: '采集小红书用户个人资料并导出为 Excel 文件。',
    version: '0.1.0',
  },
});
