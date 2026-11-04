// Apply the owner's current name only to operational chat errors. Model names
// and service names identify the provider rather than the personal companion.
export function personalMuseError(message: string, savedName: string): string {
  const name = savedName.trim() || 'Muse';
  return message.replace(/\bMuse\b(?![ \t]+(?:Image|Spark|API|service|token counter)\b)/g, () => name);
}
