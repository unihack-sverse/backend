import { AuditLogModel } from '../modules/admin/models/audit-log.model.js';
import { publicId } from './ids.js';

export async function writeAudit({ actor, action, targetType, targetId, reason = '', before, after, requestId }, session) {
  await AuditLogModel.create(
    [
      {
        pid: publicId('aud'),
        actorType: actor?.type ?? 'user',
        actorId: actor?.id ?? null,
        action,
        targetType,
        targetId: String(targetId),
        reason,
        before: before ?? null,
        after: after ?? null,
        requestId: requestId ?? null,
      },
    ],
    { session },
  );
}
