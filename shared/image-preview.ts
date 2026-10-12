const imageTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};
export const imagePreviewLimit = 20 * 1024 * 1024;
export function imageMime(file: string): string | undefined {
  const extension = file.split('.').at(-1)?.toLowerCase() || '';
  return Object.hasOwn(imageTypes, extension) ? imageTypes[extension] : undefined;
}
