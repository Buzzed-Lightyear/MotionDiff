export function posyBlend(curData, oldData, outData, threshold) {
  const len = curData.length;
  for (let i = 0; i < len; i += 4) {
    // blend = (current + invert(old) + 1) >> 1 — the +1 before >>1 rounds to nearest
    let bR = ((curData[i]     + (255 - oldData[i]))     + 1) >> 1;
    let bG = ((curData[i + 1] + (255 - oldData[i + 1])) + 1) >> 1;
    let bB = ((curData[i + 2] + (255 - oldData[i + 2])) + 1) >> 1;

    const devR = Math.abs(bR - 128);
    const devG = Math.abs(bG - 128);
    const devB = Math.abs(bB - 128);
    const mag = (devR + devG + devB) / 3;

    if (mag < threshold) {
      outData[i]     = 128;
      outData[i + 1] = 128;
      outData[i + 2] = 128;
    } else {
      outData[i]     = bR;
      outData[i + 1] = bG;
      outData[i + 2] = bB;
    }
    outData[i + 3] = 255;
  }
}

export function rawDiff(curData, oldData, outData, threshold) {
  const len = curData.length;
  for (let i = 0; i < len; i += 4) {
    let dR = Math.abs(curData[i]     - oldData[i]);
    let dG = Math.abs(curData[i + 1] - oldData[i + 1]);
    let dB = Math.abs(curData[i + 2] - oldData[i + 2]);
    const mag = (dR + dG + dB) / 3;

    if (mag < threshold) {
      outData[i]     = 0;
      outData[i + 1] = 0;
      outData[i + 2] = 0;
    } else {
      outData[i]     = dR;
      outData[i + 1] = dG;
      outData[i + 2] = dB;
    }
    outData[i + 3] = 255;
  }
}
