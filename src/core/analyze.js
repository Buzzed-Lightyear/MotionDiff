function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function analyzeSample(frames, fps) {
  if (!Array.isArray(frames) || frames.length < 2) {
    return { frameOffset: 5, threshold: 10 };
  }

  let motionSum = 0;
  let pixelCount = 0;

  for (let index = 1; index < frames.length; index++) {
    const current = frames[index];
    const previous = frames[index - 1];
    const len = Math.min(current.length, previous.length);

    for (let offset = 0; offset < len; offset += 4) {
      const diffR = Math.abs(current[offset] - previous[offset]);
      const diffG = Math.abs(current[offset + 1] - previous[offset + 1]);
      const diffB = Math.abs(current[offset + 2] - previous[offset + 2]);
      motionSum += (diffR + diffG + diffB) / 3;
      pixelCount++;
    }
  }

  const avgMotion = pixelCount ? motionSum / pixelCount : 0;
  const threshold = Math.round(clamp(avgMotion * 0.4, 5, 40));

  if (avgMotion < 5) {
    return { frameOffset: 15, threshold };
  }

  if (avgMotion < 15) {
    return { frameOffset: 5, threshold };
  }

  return { frameOffset: 2, threshold };
}
