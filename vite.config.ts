import path from 'node:path'
import { readdir } from 'node:fs/promises'
import sharp from 'sharp'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

function optimizeSpecialFlightImages(): Plugin {
  return {
    name: 'optimize-special-flight-images',
    apply: 'build',
    async generateBundle() {
      const inputDir = path.resolve(process.cwd(), 'public/special-flights')
      const files = await readdir(inputDir)

      const imageFiles = files.filter((file) => /\.(jpe?g|png)$/i.test(file))

      for (const file of imageFiles) {
        const sourcePath = path.join(inputDir, file)
        const baseName = file.replace(/\.[^.]+$/, '')

        const markerImage = sharp(sourcePath)
          .resize(256, 256, { fit: 'cover', position: 'centre' })

        const cardImage = sharp(sourcePath)
          .resize(960, 540, { fit: 'cover', position: 'centre' })

        const [markerWebp, cardWebp] = await Promise.all([
          markerImage.clone().webp({ quality: 72 }).toBuffer(),
          cardImage.clone().webp({ quality: 78 }).toBuffer(),
        ])

        this.emitFile({
          type: 'asset',
          fileName: `special-flights/marker/${baseName}.webp`,
          source: markerWebp,
        })
        this.emitFile({
          type: 'asset',
          fileName: `special-flights/card/${baseName}.webp`,
          source: cardWebp,
        })
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), optimizeSpecialFlightImages()],
  base: '/flightmap/',
})
