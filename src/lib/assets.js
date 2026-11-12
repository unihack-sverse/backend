import { env } from '../config/env.js';

export function publicAssetUrl(value) {
  if (!value || !env.PUBLIC_ASSET_BASE) return value;

  try {
    const url = new URL(value, env.PUBLIC_ASSET_BASE);
    if (!url.pathname.startsWith('/assets/')) return value;
    return `${env.PUBLIC_ASSET_BASE.replace(/\/$/, '')}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}

export function publicAsset(asset) {
  if (!asset?.url) return asset;
  return { ...asset, url: publicAssetUrl(asset.url) };
}
