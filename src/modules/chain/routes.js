import { Router } from 'express';

import { asyncHandler } from '../../lib/async-handler.js';
import { sendData } from '../../lib/respond.js';
import { chainService } from './services/chain.service.js';

export function chainRoutes() {
  const router = Router();
  router.get(
    '/chain/status',
    asyncHandler(async (_req, res) => {
      const status = await chainService.status();
      sendData(res, { adapter: status.adapter, chainId: status.chainId, network: status.network, explorer: status.explorer, contracts: status.contracts, indexedBlock: status.indexedBlock });
    }),
  );
  return router;
}
