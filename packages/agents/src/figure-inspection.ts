import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface FigureInspection {
  width: number;
  height: number;
  blank?: boolean;
  clippedEdges?: string[];
}

const pillowProbe = `
import json
import sys
from collections import Counter
from PIL import Image, ImageStat

with Image.open(sys.argv[1], formats=["PNG"]) as source:
    image = source.convert("RGBA")
    width, height = image.size
    canvas = Image.new("RGBA", image.size, "white")
    canvas.alpha_composite(image)
    rgb = canvas.convert("RGB")
    corners = [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]
    colors = Counter(rgb.getpixel(point) for point in corners)
    background, corner_count = colors.most_common(1)[0]
    edges = {
        "top": rgb.crop((0, 0, width, 1)),
        "bottom": rgb.crop((0, height - 1, width, height)),
        "left": rgb.crop((0, 0, 1, height)),
        "right": rgb.crop((width - 1, 0, width, height)),
    }
    clipped = []
    if corner_count >= 2:
        for name, edge in edges.items():
            ink = sum(max(abs(a - b) for a, b in zip(pixel, background)) >= 32 for pixel in edge.getdata())
            if ink >= 3:
                clipped.append(name)
    print(json.dumps(dict(width=width, height=height, blank=max(ImageStat.Stat(rgb).var) < 0.01,
                          clippedEdges=clipped)))
`;

export async function inspectPng(filePath: string, pythonExecutable?: string, signal?: AbortSignal): Promise<FigureInspection> {
  signal?.throwIfAborted();
  const file = await fs.open(filePath, 'r');
  const header = Buffer.alloc(33);
  try {
    const { bytesRead } = await file.read(header);
    if (bytesRead < header.length || !header.subarray(0, 8).equals(pngSignature) ||
      header.readUInt32BE(8) !== 13 || header.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('Invalid PNG header');
    }
  } finally {
    await file.close();
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) throw new Error('Invalid PNG dimensions');
  if (width * height > 25_000_000) return { width, height };
  try {
    const { stdout } = await runFile(pythonExecutable || process.env.SCIDEV_PYTHON_BIN || 'python',
      ['-I', '-B', '-c', pillowProbe, filePath], { timeout: 5000, windowsHide: true, signal });
    return JSON.parse(stdout) as FigureInspection;
  } catch {
    signal?.throwIfAborted();
    return { width, height };
  }
}
