import fs from 'node:fs';
import path from 'node:path';
import { VECTOR_STORAGE_ARCHITECTURE } from './vector-storage-architecture.js';

const apiRoot = process.cwd();
const schemaPath = path.join(apiRoot, 'prisma/schema.prisma');
const packagePath = path.join(apiRoot, 'package.json');

const FORBIDDEN_VECTOR_PACKAGES = [
  '@pinecone-database/pinecone',
  '@qdrant/js-client-rest',
  'weaviate-client',
  'chromadb',
  '@zilliz/milvus2-sdk-node',
  '@lancedb/lancedb',
] as const;

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.isFile() && /\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function importedPackages(source: string): string[] {
  const packages: string[] = [];
  const re = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(re)) packages.push(match[1]!);
  return packages;
}

describe('Knowledge Plane Phase 10 vector-storage architecture', () => {
  it('pins vector storage to the existing shared Postgres + pgvector substrate', () => {
    const schema = fs.readFileSync(schemaPath, 'utf8');

    expect(VECTOR_STORAGE_ARCHITECTURE).toMatchObject({
      database: 'postgresql',
      vectorExtension: 'pgvector',
      sharedEmbeddingModel: 'ContextEmbedding',
      sharedRetrievalPlane: 'RetrievalV2',
      providerDefinesArchitecture: false,
      allowFeatureSpecificVectorStore: false,
      allowMeriSpecificVectorStore: false,
    });
    expect(schema).toMatch(/datasource\s+db\s*{[\s\S]*provider\s*=\s*"postgresql"/);
    expect(schema).toMatch(/extensions\s*=\s*\[[^\]]*pgvector\(map:\s*"vector"\)/);
    expect(schema).toMatch(/model\s+ContextEmbedding\s*{/);
  });

  it('does not add a dedicated vector-database SDK to the API dependency graph', () => {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const dependencies = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);

    for (const forbidden of FORBIDDEN_VECTOR_PACKAGES) {
      expect(dependencies.has(forbidden)).toBe(false);
    }
  });

  it('prevents Meri and Retrieval V2 from importing a separate vector-store client', () => {
    const roots = [path.join(apiRoot, 'src/meri'), path.join(apiRoot, 'src/retrieval')];
    const violations: string[] = [];

    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      for (const file of sourceFiles(root)) {
        if (file.endsWith('vector-storage-architecture.contract.spec.ts')) continue;
        const imports = importedPackages(fs.readFileSync(file, 'utf8'));
        for (const forbidden of FORBIDDEN_VECTOR_PACKAGES) {
          if (imports.includes(forbidden)) {
            violations.push(`${path.relative(apiRoot, file)} imports ${forbidden}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
