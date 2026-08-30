import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ReportExportDto, ReportPreflightDto } from "./report-export.dto.js";

describe("report export DTOs", () => {
  it("parses every preflight query option without implicit boolean coercion", async () => {
    const dto = plainToInstance(ReportPreflightDto, {
      format: "pptx",
      audience: "internal",
      useClientLogo: "false",
      includeRoadmap: "true",
      includeEvidenceAppendix: "false",
      includeChangeLog: "true",
      includeInternalNotes: "true",
      includeAgentHistory: "false",
    });

    expect(await validate(dto)).toEqual([]);
    expect(dto).toMatchObject({
      format: "pptx",
      audience: "internal",
      useClientLogo: false,
      includeRoadmap: true,
      includeEvidenceAppendix: false,
      includeChangeLog: true,
      includeInternalNotes: true,
      includeAgentHistory: false,
    });
  });

  it("rejects ambiguous query booleans", async () => {
    const dto = plainToInstance(ReportPreflightDto, {
      includeRoadmap: "yes",
    });
    expect((await validate(dto)).map((error) => error.property)).toContain(
      "includeRoadmap",
    );
  });

  it("accepts only a canonical sha256 optimistic concurrency token", async () => {
    const valid = plainToInstance(ReportExportDto, {
      format: "docx",
      audience: "client",
      expectedSnapshotHash: "a".repeat(64),
    });
    expect(await validate(valid)).toEqual([]);

    const invalid = plainToInstance(ReportExportDto, {
      format: "docx",
      audience: "client",
      expectedSnapshotHash: "not-a-snapshot-hash",
    });
    expect((await validate(invalid)).map((error) => error.property)).toContain(
      "expectedSnapshotHash",
    );
  });
});
