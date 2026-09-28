// server/src/ytdlp/slug.ts
const ILLEGAL = /[\\/:*?"<>|]/g;
export function slugify(title: string): string {
  return title.replace(ILLEGAL, '_').trim().slice(0, 80);
}
export function resolveUniquePath(dir: string, filename: string, exists: (p: string) => boolean): string {
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
  const base = ext ? filename.slice(0, filename.lastIndexOf('.')) : filename;
  let candidate = filename;
  for (let n = 2; exists(join(dir, candidate)); n++) candidate = `${base}-${n}${ext}`;
  return join(dir, candidate);
}
import { join } from 'node:path';
