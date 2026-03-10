import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const SCRIPTS = [
  '/core/websock.js',
  '/core/util/events.js',
  '/core/util/logging.js',
  '/core/util/strings.js',
  '/core/util/cursor.js',
  '/core/util/element.js',
  '/core/util/int.js',
  '/core/util/browser.js',
  '/core/input/keysym.js',
  '/core/input/keyboard.js',
  '/core/input/gesturehandler.js',
  '/core/input/util.js',
  '/core/display.js',
  '/core/encodings.js',
  '/core/inflator.js',
  '/core/deflator.js',
  '/core/decoders/copyrect.js',
  '/core/decoders/raw.js',
  '/core/decoders/rre.js',
  '/core/decoders/hextile.js',
  '/core/decoders/zlib.js',
  '/core/decoders/tight.js',
  '/core/decoders/tightpng.js',
  '/core/decoders/zrle.js',
  '/core/decoders/jpeg.js',
  '/core/ra2.js',
  '/core/rfb.js',
]

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    target: 'esnext',
    rollupOptions: {
      external: SCRIPTS
    }
  }
})
