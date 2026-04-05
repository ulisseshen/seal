import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TMP_DIR = path.join(os.tmpdir(), 'seal-audio');

/**
 * Transcribe an audio file using whisper-cli.
 * Accepts any format ffmpeg can decode (ogg, mp3, wav, m4a, etc).
 * Returns the transcribed text.
 */
export function transcribe(audioPath, config) {
  const { binary, model, language } = config.transcription;

  if (!fs.existsSync(model)) {
    throw new Error(`Whisper model not found at ${model}. Download it first.`);
  }

  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });

  // whisper-cli needs 16kHz WAV — convert with ffmpeg if not already wav
  let wavPath = audioPath;
  const ext = path.extname(audioPath).toLowerCase();
  if (ext !== '.wav') {
    wavPath = path.join(TMP_DIR, `${path.basename(audioPath, ext)}.wav`);
    try {
      execSync(`ffmpeg -y -i "${audioPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}" 2>/dev/null`);
    } catch (err) {
      throw new Error(`ffmpeg conversion failed. Is ffmpeg installed? ${err.message}`);
    }
  }

  try {
    const args = [
      `-m "${model}"`,
      `-l ${language}`,
      '--no-timestamps',
      '--no-prints',
      `-f "${wavPath}"`,
    ];

    const output = execSync(`${binary} ${args.join(' ')} 2>/dev/null`, {
      timeout: 300_000, // 5 min max per transcription
      encoding: 'utf-8',
    });

    return output.trim();
  } finally {
    // Clean up temp wav if we created one
    if (wavPath !== audioPath && fs.existsSync(wavPath)) {
      fs.unlinkSync(wavPath);
    }
  }
}

/**
 * Transcribe a buffer (e.g., from email attachment or WhatsApp download).
 * Writes to temp file, transcribes, cleans up.
 */
export function transcribeBuffer(buffer, filename, config) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const tmpPath = path.join(TMP_DIR, filename);

  try {
    fs.writeFileSync(tmpPath, buffer);
    return transcribe(tmpPath, config);
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}
