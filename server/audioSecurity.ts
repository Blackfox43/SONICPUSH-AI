import crypto from 'crypto';
import path from 'path';

export const MAX_AUDIO_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
export const DEFAULT_AUDIO_RETENTION_DAYS = Number(process.env.AUDIO_RETENTION_DAYS) || 90;

export const SUPPORTED_AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
  'audio/x-flac',
]);

export const SUPPORTED_AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.m4a',
  '.mp4',
  '.aac',
  '.ogg',
  '.oga',
  '.flac',
  '.webm',
]);

export type DetectedAudioFormat = 'mp3' | 'wav' | 'ogg' | 'flac' | 'm4a' | 'aac' | 'webm';

export interface AudioValidationResult {
  valid: boolean;
  detectedFormat?: DetectedAudioFormat;
  canonicalMimeType?: string;
  extension?: string;
  error?: string;
}

export function detectAudioMagicSignature(buffer: Buffer): DetectedAudioFormat | null {
  if (!buffer || buffer.length < 12) {
    return null;
  }

  // WAV: "RIFF" .... "WAVE"
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x41 &&
    buffer[10] === 0x56 &&
    buffer[11] === 0x45
  ) {
    return 'wav';
  }

  // OGG: "OggS"
  if (buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
    return 'ogg';
  }

  // FLAC: "fLaC"
  if (buffer[0] === 0x66 && buffer[1] === 0x4c && buffer[2] === 0x61 && buffer[3] === 0x43) {
    return 'flac';
  }

  // MP4 / M4A container: "ftyp" at offset 4
  if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    return 'm4a';
  }

  // WebM / EBML: 1A 45 DF A3
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return 'webm';
  }

  // MP3 with ID3 tag: "ID3"
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return 'mp3';
  }

  // AAC ADIF header: "ADIF"
  if (buffer[0] === 0x41 && buffer[1] === 0x44 && buffer[2] === 0x49 && buffer[3] === 0x46) {
    return 'aac';
  }

  // AAC ADTS frame sync: 0xFF 0xF1 or 0xFF 0xF9
  if (buffer[0] === 0xff && (buffer[1] === 0xf1 || buffer[1] === 0xf9)) {
    return 'aac';
  }

  // Raw MPEG-1/2 Layer III frame sync (11 bits set + Layer III bits)
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    const layer = (buffer[1] >> 1) & 0x03;
    if (layer === 1) {
      return 'mp3';
    }
  }

  return null;
}

const FORMAT_META: Record<DetectedAudioFormat, { mime: string; ext: string }> = {
  mp3: { mime: 'audio/mpeg', ext: 'mp3' },
  wav: { mime: 'audio/wav', ext: 'wav' },
  ogg: { mime: 'audio/ogg', ext: 'ogg' },
  flac: { mime: 'audio/flac', ext: 'flac' },
  m4a: { mime: 'audio/mp4', ext: 'm4a' },
  aac: { mime: 'audio/aac', ext: 'aac' },
  webm: { mime: 'audio/webm', ext: 'webm' },
};

export function validateAudioUpload(
  buffer: Buffer,
  declaredMime: string,
  originalFilename: string
): AudioValidationResult {
  if (!buffer || buffer.length === 0) {
    return { valid: false, error: 'Audio upload buffer is empty.' };
  }
  if (buffer.length > MAX_AUDIO_SIZE_BYTES) {
    return { valid: false, error: 'Audio file exceeds the 20 MB maximum upload limit.' };
  }

  const normalizedMime = (declaredMime || '').toLowerCase().trim();
  if (!SUPPORTED_AUDIO_MIMES.has(normalizedMime)) {
    return {
      valid: false,
      error: `Unsupported audio MIME type (${declaredMime || 'unknown'}). Allowed: MP3, WAV, M4A, AAC, OGG, FLAC, WebM.`,
    };
  }

  const ext = path.extname(originalFilename || '').toLowerCase();
  if (ext && !SUPPORTED_AUDIO_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      error: `Unsupported audio file extension (${ext}). Allowed: .mp3, .wav, .m4a, .aac, .ogg, .flac, .webm.`,
    };
  }

  const detected = detectAudioMagicSignature(buffer);
  if (!detected) {
    return {
      valid: false,
      error:
        'File binary signature does not match a recognized audio format (MP3, WAV, M4A, AAC, OGG, FLAC, or WebM). Spoofed or corrupted files are rejected.',
    };
  }

  // Prevent cross-format spoofing (e.g., WAV header disguised with .mp3 or vice versa)
  const expectedFromExt = ext === '.mp4' ? 'm4a' : ext === '.oga' ? 'ogg' : ext.replace('.', '');
  if (expectedFromExt && expectedFromExt !== detected) {
    return {
      valid: false,
      error: `File extension (.${expectedFromExt}) does not match detected binary audio signature (${detected.toUpperCase()}).`,
    };
  }

  const meta = FORMAT_META[detected];
  return {
    valid: true,
    detectedFormat: detected,
    canonicalMimeType: meta.mime,
    extension: meta.ext,
  };
}

export function generateSafeAudioStorageDescriptor(
  organizationId: string,
  extension: string,
  retentionDays = DEFAULT_AUDIO_RETENTION_DAYS
): {
  storageObjectPath: string;
  safeFilename: string;
  retentionExpiresAt: string;
} {
  const safeOrg = organizationId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  const safeExt = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp3';
  const safeFilename = `${crypto.randomUUID()}.${safeExt}`;
  const expires = new Date();
  expires.setUTCDate(expires.getUTCDate() + Math.max(1, retentionDays));
  return {
    storageObjectPath: `organizations/${safeOrg}/audio/${safeFilename}`,
    safeFilename,
    retentionExpiresAt: expires.toISOString(),
  };
}
