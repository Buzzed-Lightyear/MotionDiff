export function boxBlur(data, width, height) {
  const src = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const idx = (ny * width + nx) * 4;
            rSum += src[idx];
            gSum += src[idx + 1];
            bSum += src[idx + 2];
            count++;
          }
        }
      }
      const idx = (y * width + x) * 4;
      data[idx]     = (rSum / count + 0.5) | 0;
      data[idx + 1] = (gSum / count + 0.5) | 0;
      data[idx + 2] = (bSum / count + 0.5) | 0;
      data[idx + 3] = 255;
    }
  }
}
