import { describe, expect, it } from 'vitest';

import { app } from '../helpers.js';
import { DeedModel } from '../../src/modules/deeds/models/index.js';
import { deedsService } from '../../src/modules/deeds/services/deeds.service.js';
import { publicId } from '../../src/lib/ids.js';
import mongoose from 'mongoose';

describe('invariant 4 — deeds are append-only', () => {
  it('model layer: updates and deletes throw', async () => {
    const id = new mongoose.Types.ObjectId();
    const [deed] = await DeedModel.create([
      {
        pid: publicId('ded'),
        inventoryItemId: id,
        userId: id,
        gameId: id,
        studioId: id,
        deedType: 'boss_defeated',
        epoch: 1,
        nonce: 'nonce-1234',
        studioSignature: 'sha256=x',
        payloadHash: 'sha256:x',
      },
    ]);
    await expect(DeedModel.updateOne({ _id: deed._id }, { $set: { deedType: 'x' } })).rejects.toMatchObject({ code: 'deeds_are_append_only' });
    await expect(DeedModel.findOneAndUpdate({ _id: deed._id }, { $set: { deedType: 'x' } })).rejects.toMatchObject({ code: 'deeds_are_append_only' });
    await expect(DeedModel.deleteOne({ _id: deed._id })).rejects.toMatchObject({ code: 'deeds_are_append_only' });
    await expect(DeedModel.deleteMany({})).rejects.toMatchObject({ code: 'deeds_are_append_only' });
    const doc = await DeedModel.findById(deed._id);
    doc.deedType = 'tampered';
    await expect(doc.save()).rejects.toMatchObject({ code: 'deeds_are_append_only' });
  });

  it('service layer: exposes append and reads only', () => {
    const names = Object.keys(deedsService);
    expect(names.some((name) => /update|delete|remove|edit/i.test(name))).toBe(false);
  });

  it('router layer: no PATCH/DELETE route touches deeds', () => {
    const routes = [];
    const walk = (stack, prefix = '') => {
      for (const layer of stack) {
        if (layer.route) routes.push(...Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${prefix}${layer.route.path}`));
        else if (layer.handle?.stack) walk(layer.handle.stack, prefix);
      }
    };
    walk(app._router.stack);
    const offending = routes.filter((route) => /deed/i.test(route) && /^(PATCH|DELETE|PUT)/.test(route));
    expect(routes.some((route) => route.includes('deeds'))).toBe(true);
    expect(offending).toEqual([]);
  });
});
