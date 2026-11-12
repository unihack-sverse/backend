import { publicId } from '../../../lib/ids.js';
import { toBigInt } from '../../../lib/money.js';
import { UserModel } from '../../auth/models/index.js';
import { CuratorAttributionModel } from '../models/index.js';

const ATTRIBUTION_DAYS = 90;

export const curationService = {
  /** UC-28: first-touch attribution for 90 days; self-referral and same-device signups are flagged. */
  async bindReferral({ referredUser, code, ipHash, uaHash }) {
    const curator = await UserModel.findOne({ 'referral.code': String(code).toLowerCase() }).select('+reputationInputs').lean();
    if (!curator) return null;
    const self = String(curator._id) === String(referredUser._id);
    // IP alone would flag every attendee of a ReadyPlayerS event on shared venue Wi-Fi, so a
    // "same device" needs the same network AND the same client signature. Flags are reviewable.
    const sameDevice = Boolean(ipHash && uaHash && curator.signupIpHash === ipHash && curator.signupUaHash === uaHash);
    if (self) return null;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ATTRIBUTION_DAYS * 86_400_000);
    try {
      const attribution = await CuratorAttributionModel.create({
        pid: publicId('cur'),
        curatorUserId: curator._id,
        referredUserId: referredUser._id,
        boundAt: now,
        expiresAt,
        flagged: sameDevice,
        flagReason: sameDevice ? 'same_device_signup' : null,
      });
      await UserModel.updateOne({ _id: referredUser._id }, { $set: { 'referral.referredBy': curator._id, 'referral.boundUntil': expiresAt } });
      return attribution.toObject();
    } catch (error) {
      if (error?.code === 11000) return null;
      throw error;
    }
  },

  async recordSpend({ userId, amountUnits }, session) {
    const filter = { referredUserId: userId, flagged: false, expiresAt: { $gt: new Date() } };
    const result = await CuratorAttributionModel.updateOne(filter, { $inc: { attributedUnits: toBigInt(amountUnits) } }, { session });
    if (result.modifiedCount) {
      await CuratorAttributionModel.updateOne({ ...filter, firstSpendAt: null }, { $set: { firstSpendAt: new Date() } }, { session });
    }
  },

  async summaryFor(userId) {
    const rows = await CuratorAttributionModel.find({ curatorUserId: userId }).lean();
    return {
      referred: rows.length,
      active: rows.filter((row) => row.expiresAt > new Date() && !row.flagged).length,
      flagged: rows.filter((row) => row.flagged).length,
      attributedUnits: rows.reduce((sum, row) => sum + toBigInt(row.attributedUnits), 0n).toString(),
    };
  },
};
