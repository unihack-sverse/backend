import { afterEach, describe, expect, it } from 'vitest';

import { checkoutService } from '../../src/modules/checkout/services/checkout.service.js';
import { OrderModel } from '../../src/modules/checkout/models/index.js';
import { InventoryItemModel } from '../../src/modules/inventory/models/index.js';
import { ItemDefinitionModel } from '../../src/modules/items/models/index.js';
import { LedgerEntryModel } from '../../src/modules/ledger/models/index.js';
import { ChainOpModel } from '../../src/modules/chain/models/index.js';
import { ledgerService } from '../../src/modules/ledger/services/ledger.service.js';
import { toBigInt } from '../../src/lib/money.js';
import { cosmetic, createLiveGame, registerPlayer, unique } from '../helpers.js';

const STEPS = ['supply', 'ledger', 'mint', 'lock', 'order', 'commit'];

describe('invariant 3 — checkout is atomic', () => {
  afterEach(() => STEPS.forEach((step) => checkoutService.setFailpoint(step, false)));

  for (const step of STEPS) {
    it(`a failure at "${step}" leaves zero partial state`, async () => {
      const { items } = await createLiveGame({ items: [cosmetic({ supplyMax: 10 })] });
      const buyer = await registerPlayer({ fund: 200_000_000n });
      const intent = await buyer.agent.post('/api/v1/checkout/intents').set('Idempotency-Key', `${unique('k')}12345678`).send({ itemDefinitionId: items[0].id });
      expect(intent.status).toBe(201);
      const definition = await ItemDefinitionModel.findOne({ pid: items[0].id }).lean();
      const entriesBefore = await LedgerEntryModel.countDocuments();
      const opsBefore = await ChainOpModel.countDocuments();

      checkoutService.setFailpoint(step, true);
      const res = await buyer.agent.post(`/api/v1/checkout/intents/${intent.body.data.id}/confirm`).send({});
      checkoutService.setFailpoint(step, false);
      expect(res.status).toBe(500);

      expect(await LedgerEntryModel.countDocuments()).toBe(entriesBefore);
      expect(await ChainOpModel.countDocuments()).toBe(opsBefore);
      expect(await InventoryItemModel.countDocuments({ userId: buyer.user._id })).toBe(0);
      expect((await ItemDefinitionModel.findById(definition._id).lean()).supply.minted).toBe(definition.supply.minted);
      expect(toBigInt((await ledgerService.walletFor(buyer.user._id)).balanceUnits)).toBe(200_000_000n);
      const order = await OrderModel.findOne({ pid: intent.body.data.id }).lean();
      expect(order.status).toBe('failed');
      expect(order.ledgerTxId).toBeNull();
    });
  }
});
