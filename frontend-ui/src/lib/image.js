// Resize photos before uploading them to the API.
const MAX_WIDTH = 1600
const MAX_HEIGHT = 1200
const TARGET_BYTES = 900 * 1024
const QUALITIES = [0.82, 0.7, 0.6]

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That image couldn't be opened — try a JPEG or PNG.")) }
    img.src = url
  })
}

const toBlob = (canvas, quality) =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Preparing that image failed.'))), 'image/jpeg', quality)
  })

export async function prepareImage(file) {
  if (!file.type.startsWith('image/')) throw new Error('That’s not an image file.')

  const img = await loadImage(file)
  const scale = Math.min(1, MAX_WIDTH / img.naturalWidth, MAX_HEIGHT / img.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))

  const ctx = canvas.getContext('2d')
  // Give transparent PNGs a white background before converting to JPEG.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

  let blob = await toBlob(canvas, QUALITIES[0])
  for (let i = 1; i < QUALITIES.length && blob.size > TARGET_BYTES; i += 1) {
    blob = await toBlob(canvas, QUALITIES[i])
  }
  return blob
}
