import { ObjectId, Schema, appendOnly, model } from '../../../db/model-helpers.js';

const auditLogSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    actorType: { type: String, enum: ['user', 'system', 'api_key'], default: 'user' },
    actorId: { type: ObjectId, default: null },
    action: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: String, required: true },
    reason: { type: String, default: '' },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    ipHash: { type: String, default: null },
    requestId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });

appendOnly(auditLogSchema, 'audit_log_is_append_only');

export const AuditLogModel = model('AuditLog', auditLogSchema, 'auditLogs');
