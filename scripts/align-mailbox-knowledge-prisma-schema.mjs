import { readFileSync, writeFileSync } from 'node:fs';

const schemaPath = 'apps/api/prisma/schema.prisma';
let schema = readFileSync(schemaPath, 'utf8');

function addRelationField(modelName, mapName, fieldLine, marker) {
  if (schema.includes(marker)) return;
  const pattern = new RegExp(
    `(model ${modelName} \\{[\\s\\S]*?)(\\n  @@map\\("${mapName}"\\)\\n\\})`,
  );
  if (!pattern.test(schema)) {
    throw new Error(`Could not find model ${modelName} / @@map("${mapName}") anchor.`);
  }
  schema = schema.replace(pattern, `$1\n${fieldLine}$2`);
}

addRelationField(
  'Tenant',
  'tenants',
  '  knowledgeMailboxJobs               KnowledgeMailboxJob[]',
  'knowledgeMailboxJobs               KnowledgeMailboxJob[]',
);
addRelationField(
  'MailMessage',
  'mail_messages',
  '  knowledgeJobs KnowledgeMailboxJob[]',
  'knowledgeJobs KnowledgeMailboxJob[]',
);
addRelationField(
  'KnowledgeEvent',
  'knowledge_events',
  '  mailboxJobs KnowledgeMailboxJob[]',
  'mailboxJobs KnowledgeMailboxJob[]',
);

if (!schema.includes('model KnowledgeMailboxJob {')) {
  schema = `${schema.trimEnd()}\n\n// Enterprise Context Plane — Phase 4 asynchronous mailbox ingestion outbox.\nmodel KnowledgeMailboxJob {\n  id                   String    @id @default(uuid()) @db.Uuid\n  tenantId             String    @map("tenant_id") @db.Uuid\n  mailMessageId        String    @map("mail_message_id") @db.Uuid\n  sourceRevision       String    @map("source_revision") @db.VarChar(64)\n  status               String    @default("pending") @db.VarChar(24)\n  attemptCount         Int       @default(0) @map("attempt_count")\n  availableAt          DateTime  @default(now()) @map("available_at") @db.Timestamptz(6)\n  lockedAt             DateTime? @map("locked_at") @db.Timestamptz(6)\n  lockedBy             String?   @map("locked_by") @db.VarChar(160)\n  lastError            String?   @map("last_error") @db.Text\n  relevance            Json?\n  resultEventId        String?   @map("result_event_id") @db.Uuid\n  processedContentHash String?   @map("processed_content_hash") @db.VarChar(64)\n  createdAt            DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)\n  updatedAt            DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)\n\n  tenant      Tenant          @relation(fields: [tenantId], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "knowledge_mailbox_jobs_tenant_fkey")\n  mailMessage MailMessage     @relation(fields: [mailMessageId], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "knowledge_mailbox_jobs_message_fkey")\n  resultEvent KnowledgeEvent? @relation(fields: [resultEventId], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "knowledge_mailbox_jobs_event_fkey")\n\n  @@unique([tenantId, mailMessageId, sourceRevision], map: "knowledge_mailbox_jobs_identity_unique")\n  @@index([tenantId, mailMessageId, createdAt(sort: Desc)], map: "knowledge_mailbox_jobs_tenant_message_idx")\n  // Partial operational indexes are created by the SQL migration because Prisma\n  // cannot represent WHERE predicates on indexes without changing their meaning.\n  @@map("knowledge_mailbox_jobs")\n}\n`;
}

writeFileSync(schemaPath, schema);
