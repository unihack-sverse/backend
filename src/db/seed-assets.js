import { mkdir, access, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const backendPublicDir = fileURLToPath(new URL('../../public', import.meta.url));
const legacyPublicDir = fileURLToPath(new URL('../public', import.meta.url));
export const seedAssetDir = path.join(backendPublicDir, 'seed');
const legacySeedAssetDir = path.join(legacyPublicDir, 'seed');

export function seedAssetUrl(assetBaseUrl, relativePath) {
  return `${assetBaseUrl}/assets/seed/${relativePath.replace(/\\/g, '/')}`;
}

export async function clearSeedAssets() {
  await rm(seedAssetDir, { recursive: true, force: true });
  await rm(legacySeedAssetDir, { recursive: true, force: true });
}

export async function ensureSeedImage(spec, options) {
  const { apiKey, model, force = false } = options;
  const outputPath = path.join(seedAssetDir, spec.relativePath);

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required to generate seed images.');
  }

  if (!force && (await fileExists(outputPath))) {
    return outputPath;
  }

  await mkdir(path.dirname(outputPath), { recursive: true });

  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt: spec.prompt,
      n: 1,
      size: spec.size,
      response_format: 'b64_json',
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini image generation failed for ${spec.relativePath}: ${response.status} ${detail}`);
  }

  const payload = await response.json();
  const b64 = payload?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error(`Gemini image generation returned no image for ${spec.relativePath}.`);
  }

  await writeFile(outputPath, Buffer.from(b64, 'base64'));
  return outputPath;
}

async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
