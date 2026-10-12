import { describe, expect, test } from '@jest/globals';
import * as catalog from '../src/cascade/cascade.config.js';
import * as registry from '../src/cascade/workspace-product.registry.js';
import { CascadeService } from '../src/cascade/cascade.service.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

// Captured from actual 802bb source before application edits. Never derive
// expectations from the registry or regenerate this fixture after conversion.
const fixtureBytes = fs.readFileSync(path.join(__dirname, 'fixtures/product-registry-before.json'));
const before = JSON.parse(fixtureBytes.toString()) as {
  names: string[];
  sectionInputs: string[];
  baselineProfile: any;
  mutationSemantics: any;
};
const names = before.names;
const firstProduct: string = names[0] ?? (() => {
  throw new Error('The frozen before fixture must contain products');
})();
const sectionInputs = before.sectionInputs;
const maps = ['PRODUCT_META', 'SUGGESTED_SECTIONS', 'SUGGESTED_PAGES'];
const lists = ['CANONICAL_PRODUCTS', 'UNIVERSAL_PRODUCTS', 'FUNDING_PRODUCTS'];

function serviceFor(config: Record<string, any>) {
  const serviceSource = fs.readFileSync(
    path.join(__dirname, '../src/cascade/cascade.service.ts'),
    'utf8',
  );
  const module = { exports: {} as Record<string, any> };
  const code = ts.transpileModule(serviceSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
    },
  }).outputText;
  vm.runInNewContext(
    code,
    {
      module,
      exports: module.exports,
      require(id: string) {
        if (id === '@nestjs/common') return { Injectable: () => (target: unknown) => target };
        if (id === './cascade.config.js') return config;
        throw new Error('Unexpected synthetic service dependency: ' + id);
      },
    },
    { timeout: 1000 },
  );
  return new module.exports.CascadeService();
}

function freshCatalog(): Record<string, any> {
  const registryPath = path.join(__dirname, '../src/cascade/workspace-product.registry.ts');
  const configPath = path.join(__dirname, '../src/cascade/cascade.config.ts');
  function load(file: string, dependency?: Record<string, any>) {
    const module = { exports: {} as Record<string, any> };
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    vm.runInNewContext(
      code,
      {
        module,
        exports: module.exports,
        require(id: string) {
          if (id === './workspace-product.registry.js' && dependency) return dependency;
          throw new Error('Unexpected pure catalog dependency: ' + id);
        },
      },
      { timeout: 1000 },
    );
    return module.exports;
  }
  return load(configPath, load(registryPath));
}

function capture(work: () => unknown) {
  try {
    const value = work();
    return {
      ok: true,
      type: typeof value,
      json: JSON.stringify(value) ?? null,
      ...(typeof value === 'function' ? { functionName: value.name } : {}),
    };
  } catch (error) {
    const failure = error as Error;
    return { ok: false, errorName: failure.name, error: failure.message };
  }
}
const oddProducts = [
  '',
  'Unknown work product',
  'white paper',
  ' White paper ',
  'toString',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'prototype',
  'valueOf',
];
function profile(catalog: Record<string, any>) {
  const w = catalog.WSC;
  const service = serviceFor(catalog);
  return {
    serializedExports: Object.fromEntries(
      ['CASCADE', ...lists, ...maps, 'INDUSTRY_DATA', 'SECTION_LIBRARY'].map((key: string) => [
        key,
        JSON.stringify(catalog[key]),
      ]),
    ),
    projectionKeys: Object.fromEntries(maps.map((key: string) => [key, Object.keys(catalog[key])])),
    allLibraryProducts: w.allLibraryProducts(),
    products: [...names, ...oddProducts].map((product: string) => ({
      product,
      meta: capture(() => w.meta(product)),
      sections: capture(() => w.suggestedSections(product)),
      pages: capture(() => w.suggestedPages(product)),
      funding: capture(() => w.isFunding(product)),
      defaults: capture(() => service.defaultsFor(product)),
    })),
    industries: [...w.industries(), 'Unknown industry', '', '__proto__'].map(
      (industry: string) => ({
        industry,
        products: capture(() => w.productsFor(industry)),
        data: capture(() => w.dataFor(industry)),
        pathways: [...names, 'Unknown work product', '__proto__'].map((product: string) => ({
          product,
          result: capture(() => w.pathwaysFor(industry, product)),
        })),
        committees: [
          [],
          ['NDAA Authorization'],
          ['Defense Appropriations', 'NDAA Authorization', 'Defense Appropriations'],
          ['unknown'],
          ['__proto__'],
        ].map((input: string[]) => ({
          input,
          result: capture(() => w.committeesFor(industry, input)),
        })),
      }),
    ),
    sections: sectionInputs.map((name: string) => ({ name, value: w.specFor(name) })),
    referenceSemantics: {
      knownMetaShared: w.meta(firstProduct) === catalog.PRODUCT_META[firstProduct],
      unknownMetaFresh: w.meta('unknown') !== w.meta('unknown'),
      sectionsFresh: w.suggestedSections(names[0]) !== w.suggestedSections(names[0]),
      knownDataShared:
        w.dataFor('Defense & Aerospace') === catalog.INDUSTRY_DATA['Defense & Aerospace'],
      knownPathwaysShared:
        w.pathwaysFor('Defense & Aerospace', 'NDAA Authorization Request') ===
        catalog.CASCADE[0].products[0].pathways,
      unknownPathwaysFresh:
        w.pathwaysFor('Defense & Aerospace', 'unknown') !==
        w.pathwaysFor('Defense & Aerospace', 'unknown'),
      libraryFresh: w.allLibraryProducts() !== w.allLibraryProducts(),
      sameWhiteAndNdaaSectionValues:
        JSON.stringify(catalog.SUGGESTED_SECTIONS['White paper']) ===
        JSON.stringify(catalog.SUGGESTED_SECTIONS['NDAA Authorization Request']),
      distinctWhiteAndNdaaSectionArrays:
        catalog.SUGGESTED_SECTIONS['White paper'] !==
        catalog.SUGGESTED_SECTIONS['NDAA Authorization Request'],
      sectionSpecFresh: w.specFor('Background') !== w.specFor('Background'),
      sectionWordTupleFresh:
        w.specFor('Background').targetWords !== w.specFor('Background').targetWords,
      unboundReceiver: capture(() => {
        const detached = w.productsFor;
        return detached('Defense & Aerospace');
      }),
    },
  };
}
function mutationProfile() {
  const c = freshCatalog(),
    w = c.WSC,
    product = 'NDAA Authorization Request';
  const meta = w.meta(product);
  meta.cover = !meta.cover;
  const metaMutationVisible = w.meta(product).cover === meta.cover;
  const sections = w.suggestedSections(product);
  sections.push('caller copy mutation');
  const returnedSectionMutationIsolated = !w
    .suggestedSections(product)
    .includes('caller copy mutation');
  c.SUGGESTED_SECTIONS[product].push('exported section mutation');
  const exportedSectionMutationVisible = w
    .suggestedSections(product)
    .includes('exported section mutation');
  c.FUNDING_PRODUCTS.push('exported funding mutation');
  const exportedFundingMutationVisible = w.isFunding('exported funding mutation');
  c.SUGGESTED_PAGES[product] = 0;
  const zeroPagesOrFallbackPreserved = w.suggestedPages(product);
  c.PRODUCT_META = {
    replacement: { icon: 'probe', personalize: false, office: true, cover: false, desc: 'probe' },
  };
  const descriptor = Object.getOwnPropertyDescriptor(c, 'PRODUCT_META');
  if (descriptor === undefined) throw new Error('The legacy metadata export must remain an alias');
  return {
    metaMutationVisible,
    returnedSectionMutationIsolated,
    exportedSectionMutationVisible,
    exportedFundingMutationVisible,
    zeroPagesOrFallbackPreserved,
    cjsExportReplacementBehavior: capture(() => w.meta('replacement')),
    cjsConstAliasDescriptor: {
      enumerable: descriptor.enumerable,
      writable: descriptor.writable,
      getter: !!descriptor.get,
    },
  };
}

describe('Workspace product registry preconversion characterization', () => {
  const observed = profile(catalog);

  test('before fixture remains the exact captured original', () => {
    expect(crypto.createHash('sha256').update(fixtureBytes).digest('hex')).toBe(
      '5b9e9a08b8ede106fa19ed8ff7f1341a1ff65729e8296c45ae2b328c37a01d9c',
    );
  });

  test('all exported data, independent key orders and eleven library entries remain exact', () => {
    expect(observed.serializedExports).toEqual(before.baselineProfile.serializedExports);
    expect(observed.projectionKeys).toEqual(before.baselineProfile.projectionKeys);
    expect(observed.allLibraryProducts).toEqual(before.baselineProfile.allLibraryProducts);
    expect(new CascadeService().allLibraryProducts()).toHaveLength(11);
    for (const key of maps) {
      expect(Object.getPrototypeOf((catalog as Record<string, any>)[key])).toBe(Object.prototype);
      expect(Object.isFrozen((catalog as Record<string, any>)[key])).toBe(false);
    }
    for (const key of lists)
      expect(Object.isFrozen((catalog as Record<string, any>)[key])).toBe(false);
  });

  test.each(before.baselineProfile.products)(
    'original product/default profile: $product',
    (expected: any) => {
      expect(observed.products.find((row) => row.product === expected.product)).toEqual(expected);
    },
  );

  test.each(before.baselineProfile.industries)(
    'original industry/pathway/committee profile: $industry',
    (expected: any) => {
      expect(observed.industries.find((row) => row.industry === expected.industry)).toEqual(
        expected,
      );
    },
  );

  test.each(before.baselineProfile.sections)(
    'original ordered section specification: $name',
    (expected: any) => {
      expect(catalog.WSC.specFor(expected.name)).toEqual(expected.value);
      expect(catalog.WSC.specFor(expected.name)).not.toBe(catalog.WSC.specFor(expected.name));
      expect(catalog.WSC.specFor(expected.name).targetWords).not.toBe(
        catalog.WSC.specFor(expected.name).targetWords,
      );
    },
  );

  test('reference, copy, prototype and detached receiver behavior remain original', () => {
    expect(observed.referenceSemantics).toEqual(before.baselineProfile.referenceSemantics);
  });

  test('fresh module preserves metadata/export mutations, zero-page fallback and writable CommonJS const aliases', () => {
    expect(mutationProfile()).toEqual(before.mutationSemantics);
  });

  test('legacy aliases retain one-time canonical projection references', () => {
    expect(catalog.PRODUCT_META).toBe(registry.WORKSPACE_PRODUCT_METADATA);
    expect(catalog.SUGGESTED_SECTIONS).toBe(registry.WORKSPACE_PRODUCT_SECTIONS);
    expect(catalog.SUGGESTED_PAGES).toBe(registry.WORKSPACE_PRODUCT_PAGES);
    expect(catalog.CANONICAL_PRODUCTS).toBe(registry.WORKSPACE_PRODUCT_CANONICAL);
    expect(catalog.UNIVERSAL_PRODUCTS).toBe(registry.WORKSPACE_PRODUCT_UNIVERSAL);
    expect(catalog.FUNDING_PRODUCTS).toBe(registry.WORKSPACE_PRODUCT_FUNDING);
    expect(Object.values(registry.WORKSPACE_PRODUCT_REGISTRY)).toHaveLength(11);
    for (const product of Object.values(registry.WORKSPACE_PRODUCT_REGISTRY)) {
      expect(catalog.PRODUCT_META[product.name]).toBe(product.metadata);
      expect(catalog.SUGGESTED_SECTIONS[product.name]).toBe(product.sections);
    }
  });
});
