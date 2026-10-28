// Encodes captured PNG frames into an animated GIF

import * as fs from 'fs';

import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import { PNG } from 'pngjs';

export interface Frame {
  /** Seconds, from the screencast metadata */
  time: number;
  png: Buffer;
}

/**
 * @param frames frames in time order; each is shown until the next one
 * @param endTime when the last frame stops being shown
 */
export function writeGif(file: string, frames: Frame[], endTime: number, maxFps = 12): void {
  const encoder = GIFEncoder();
  // Drop frames closer than 1/maxFps to the previous kept one; the kept frame then lasts longer
  const kept: Frame[] = [];
  for (const frame of frames) {
    if (!kept.length || frame.time - kept[kept.length - 1].time >= 1 / maxFps) {
      kept.push(frame);
    } else {
      kept[kept.length - 1] = { time: kept[kept.length - 1].time, png: frame.png };
    }
  }
  kept.forEach((frame, i) => {
    const next = i + 1 < kept.length ? kept[i + 1].time : endTime;
    const image = PNG.sync.read(frame.png);
    const palette = quantize(image.data, 256);
    const index = applyPalette(image.data, palette);
    encoder.writeFrame(index, image.width, image.height, {
      palette,
      delay: Math.max(20, Math.round((next - frame.time) * 1000)),
      repeat: 0,
    });
  });
  encoder.finish();
  fs.writeFileSync(file, encoder.bytes());
}
