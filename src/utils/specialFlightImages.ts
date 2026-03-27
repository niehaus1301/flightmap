function stripLeadingSlash(pathValue: string): string {
  return pathValue.replace(/^\/+/, '')
}

function getBaseName(imagePath: string): string | null {
  const cleanPath = stripLeadingSlash(imagePath)
  const extensionMatch = cleanPath.match(/^(.*)\.[^.]+$/)

  if (!extensionMatch) {
    return null
  }

  return extensionMatch[1].split('/').pop() ?? extensionMatch[1]
}

export function getCardWebpPath(imagePath: string): string {
  const cleanPath = stripLeadingSlash(imagePath)
  const baseName = getBaseName(cleanPath)

  if (!baseName) {
    return cleanPath
  }

  return `special-flights/card/${baseName}.webp`
}

export function getMarkerImageCandidates(imagePath: string): string[] {
  const cleanPath = stripLeadingSlash(imagePath)
  const baseName = getBaseName(cleanPath)

  if (!baseName) {
    return [cleanPath]
  }

  return [`special-flights/marker/${baseName}.webp`, cleanPath]
}
