from pathlib import Path

path = Path('apps/api/scripts/ingest-defense-budget-pdf.ts')
source = path.read_text()

if 'const preExistingObservationIds = new Set(' not in source:
    start = source.index(
        '      const writer = new ProgramElementWriterService(tx as unknown as PrismaService);'
    )
    end = source.index('\n\n      await recordIngestRun', start)
    replacement = '''      const writer = new ProgramElementWriterService(tx as unknown as PrismaService);
      const outcome: LoadOutcome = { upserted: 0, changed: 0, quarantined: 0 };

      for (const record of input.mapped.records) {
        const result = await writer.upsertProgramElement(record, input.source, 0.9);
        if (result.inserted) outcome.upserted += 1;
        else outcome.changed += 1;
      }

      for (const year of input.mapped.years) {
        const baseSource = input.source.replace(/_fy\\d+$/i, '');
        const values = input.mapped.sourceValues.filter(
          (value) => value.peCode === year.peCode && value.fy === year.fy,
        );
        const observedFields = [...new Set(values.map((value) => String(value.fieldName)))];
        const preExistingObservationIds = new Set(
          (
            await tx.programElementYearSourceValue.findMany({
              where: {
                peCode: year.peCode,
                fy: year.fy,
                fieldName: { in: [...observedFields, '__row__'] },
                source: { in: [input.source, baseSource] },
              },
              select: { id: true },
            })
          ).map((row) => row.id),
        );

        const result = await writer.upsertProgramElementYear(year, input.source);
        if (result.inserted) outcome.upserted += 1;
        else if (result.changed) outcome.changed += 1;

        for (const value of values) {
          const newObservations = await tx.programElementYearSourceValue.findMany({
            where: {
              peCode: value.peCode,
              fy: value.fy,
              fieldName: String(value.fieldName),
              source: { in: [input.source, baseSource] },
              sourceDocumentId: null,
              id: { notIn: [...preExistingObservationIds] },
            },
            select: { id: true },
          });
          if (newObservations.length !== 1) {
            throw new Error(
              `Expected exactly one new canonical observation for ${value.peCode} FY${value.fy} ${String(value.fieldName)}; found ${newObservations.length}`,
            );
          }
          await tx.programElementYearSourceValue.update({
            where: { id: newObservations[0]!.id },
            data: {
              sourceDocumentId: input.sourceDocumentId,
              valueJsonb: {
                canonicalValueM: value.valueM,
                originalValue: value.originalValue,
                originalUnit: value.originalUnit,
                provenance: value.provenance,
              } as unknown as Prisma.InputJsonValue,
            },
          });
        }

        const newRowObservations = await tx.programElementYearSourceValue.findMany({
          where: {
            peCode: year.peCode,
            fy: year.fy,
            fieldName: '__row__',
            source: input.source,
            sourceDocumentId: null,
            id: { notIn: [...preExistingObservationIds] },
          },
          select: { id: true },
        });
        if (newRowObservations.length !== 1) {
          throw new Error(
            `Expected exactly one new row observation for ${year.peCode} FY${year.fy}; found ${newRowObservations.length}`,
          );
        }
        await tx.programElementYearSourceValue.update({
          where: { id: newRowObservations[0]!.id },
          data: { sourceDocumentId: input.sourceDocumentId },
        });
      }'''
    source = source[:start] + replacement + source[end:]

if 'const selected = candidates[0];' not in source:
    source = source.replace(
        '  const [{ pdfPath, cls }] = candidates;\n',
        "  const selected = candidates[0];\n"
        "  if (!selected) {\n"
        "    throw new Error('Internal error: one-PDF guard passed without a selected candidate');\n"
        "  }\n"
        "  const { pdfPath, cls } = selected;\n",
        1,
    )

if 'Immutable source archive did not return an S3 VersionId' not in source:
    source = source.replace(
        "  const archive = await archiveSvc.archiveOriginal(descriptor);\n\n  const prisma = new PrismaClient();",
        "  const archive = await archiveSvc.archiveOriginal(descriptor);\n"
        "  if (!archive.versionId) {\n"
        "    throw new Error(\n"
        "      'Immutable source archive did not return an S3 VersionId; canonical promotion is blocked.',\n"
        "    );\n"
        "  }\n\n"
        "  const prisma = new PrismaClient();",
        1,
    )

if 'registered.document.supersededByDocumentId' not in source:
    source = source.replace(
        '    const sourceDocumentId = registered.document.id;\n\n'
        '    let prepared = await loadExistingParseArtifact(',
        "    if (registered.document.supersededByDocumentId) {\n"
        "      throw new Error(\n"
        "        `Approved source document ${registered.document.id} is superseded by ${registered.document.supersededByDocumentId}; promote the current source version instead.`,\n"
        "      );\n"
        "    }\n"
        "    const sourceDocument = await prisma.sourceDocument.update({\n"
        "      where: { id: registered.document.id },\n"
        "      data: {\n"
        "        archiveBucket: archive.bucket,\n"
        "        archiveS3Key: archive.key,\n"
        "        archiveVersionId: archive.versionId,\n"
        "        archiveKmsKeyArn: archive.kmsKeyArn ?? null,\n"
        "        retainUntil: archive.retainUntil,\n"
        "        archivedAt: new Date(),\n"
        "        byteSize: archive.byteSize,\n"
        "        metadata: {\n"
        "          ...asRecord(registered.document.metadata),\n"
        "          retrievalKey: archive.retrievalKey,\n"
        "          manifestKey: archive.manifestKey,\n"
        "          classification: cls,\n"
        "          canonicalMoneyUnit: 'USD millions',\n"
        "        } as unknown as Prisma.InputJsonValue,\n"
        "      },\n"
        "    });\n"
        "    const sourceDocumentId = sourceDocument.id;\n\n"
        "    let prepared = await loadExistingParseArtifact(",
        1,
    )

path.write_text(source)
