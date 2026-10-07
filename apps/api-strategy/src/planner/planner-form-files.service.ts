import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { fail } from './planner.validation.js';
import {
  PLANNER_ATTACHMENT_LIMIT,
  plannerAttachmentName,
  type PlannerFormUpload,
} from './planner-files.js';

export type PlannerPreparedFormFile = {
  id: string;
  fieldId: string;
  fileName: string;
  sizeBytes: number;
  objectKey: string;
};

/** Files use the existing private task-attachment prefix and permissions.
 * A task and its attachment rows are committed only after every upload succeeds. */
@Injectable()
export class PlannerFormFilesService {
  private readonly s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
  private readonly logger = new Logger(PlannerFormFilesService.name);
  private bucket() {
    const bucket = process.env.ASSETS_BUCKET?.trim();
    if (!bucket)
      throw new ServiceUnavailableException('Planner attachment storage is not configured');
    return bucket;
  }
  async remove(files: PlannerPreparedFormFile[]) {
    if (!files.length) return;
    const bucket = this.bucket();
    const results = await Promise.allSettled(
      files.map((file) =>
        this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: file.objectKey })),
      ),
    );
    const failed = results.filter((result) => result.status === 'rejected').length;
    if (failed)
      this.logger.warn(`Planner form rollback cleanup failed for ${failed} uncommitted files`);
  }
  async prepare(tenantId: string, taskId: string, files: PlannerFormUpload[]) {
    if (
      files.length > 10 ||
      files.reduce((total, file) => total + file.size, 0) > PLANNER_ATTACHMENT_LIMIT
    )
      fail('Forms accept up to ten files totaling 25 MB');
    const names = files.map((file) => {
      if (!Buffer.isBuffer(file.buffer) || file.size <= 0 || file.size !== file.buffer.length)
        fail('Choose a nonempty attachment');
      return plannerAttachmentName(file.originalname);
    });
    const bucket = this.bucket();
    const prepared: PlannerPreparedFormFile[] = [];
    try {
      for (const [index, file] of files.entries()) {
        const id = randomUUID();
        const metadata = {
          id,
          fieldId: file.fieldname,
          fileName: names[index]!,
          sizeBytes: file.size,
          objectKey: `tenants/${tenantId}/planner/tasks/${taskId}/${id}`,
        };
        prepared.push(metadata);
        await this.s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: metadata.objectKey,
            Body: file.buffer,
            ContentType: 'application/octet-stream',
          }),
        );
      }
      return prepared;
    } catch (error) {
      await this.remove(prepared);
      throw error;
    }
  }
}
