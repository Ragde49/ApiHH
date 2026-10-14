import { PNG } from "pngjs";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function paintDot(png, x, y, radius) {
  const minX = clamp(Math.floor(x - radius), 0, png.width - 1);
  const maxX = clamp(Math.ceil(x + radius), 0, png.width - 1);
  const minY = clamp(Math.floor(y - radius), 0, png.height - 1);
  const maxY = clamp(Math.ceil(y + radius), 0, png.height - 1);
  const radiusSq = radius * radius;
  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const dx = px - x;
      const dy = py - y;
      if (dx * dx + dy * dy > radiusSq) continue;
      const offset = (py * png.width + px) * 4;
      png.data[offset] = 28;
      png.data[offset + 1] = 37;
      png.data[offset + 2] = 69;
      png.data[offset + 3] = 255;
    }
  }
}

function paintLine(png, from, to, radius) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(Math.ceil(Math.hypot(dx, dy) / 2), 1);
  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps;
    paintDot(png, from.x + dx * ratio, from.y + dy * ratio, radius);
  }
}

export function renderSignaturePng(strokes, width = 640, height = 260) {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 255;
    png.data[index + 1] = 255;
    png.data[index + 2] = 255;
    png.data[index + 3] = 255;
  }
  for (const stroke of strokes) {
    if (!Array.isArray(stroke) || stroke.length < 1) continue;
    for (let index = 0; index < stroke.length; index += 1) {
      const current = stroke[index];
      if (
        !current ||
        !Number.isFinite(current.x) ||
        !Number.isFinite(current.y)
      )
        continue;
      const point = {
        x: clamp(current.x * width, 0, width - 1),
        y: clamp(current.y * height, 0, height - 1),
      };
      const previousRaw = stroke[index - 1];
      if (
        previousRaw &&
        Number.isFinite(previousRaw.x) &&
        Number.isFinite(previousRaw.y)
      ) {
        paintLine(
          png,
          {
            x: clamp(previousRaw.x * width, 0, width - 1),
            y: clamp(previousRaw.y * height, 0, height - 1),
          },
          point,
          3,
        );
      } else {
        paintDot(png, point.x, point.y, 3);
      }
    }
  }
  return PNG.sync.write(png);
}

export function hasSignature(strokes) {
  return (
    Array.isArray(strokes) &&
    strokes.some((stroke) => Array.isArray(stroke) && stroke.length >= 2)
  );
}
