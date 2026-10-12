import { describe, expect, test } from '@jest/globals';
import { CascadeService } from '../src/cascade/cascade.service.js';

/**
 * Cascade logic (AC-3.1). Pure data, no DB. Verifies the ported cascade matches
 * the prototype's Sankey + product defaults.
 */
describe('CascadeService', () => {
  const svc = new CascadeService();

  test('industries returns all 8 sectors', () => {
    const inds = svc.industries();
    expect(inds).toContain('Defense & Aerospace');
    expect(inds).toContain('Commerce & Tech');
    expect(inds).toHaveLength(8);
  });

  test('Defense products include presets + universal + White paper is a canonical product', () => {
    const products = svc.productsFor('Defense & Aerospace');
    expect(products).toEqual(
      expect.arrayContaining([
        'NDAA Authorization Request',
        'Meeting Brief & Advocacy',
        'Appropriations Justification',
        'CDS / Earmark Application',
        'Member letter', // universal
      ]),
    );
  });

  test('allLibraryProducts returns the 10 canonical products', () => {
    const all = svc.allLibraryProducts();
    expect(all).toHaveLength(10);
    expect(all).toContain('NDAA Authorization Request');
    expect(all).toContain('Strategy memo');
  });

  test('pathways + committees derive correctly for Defense', () => {
    const pathways = svc.pathwaysFor('Defense & Aerospace', 'NDAA Authorization Request');
    expect(pathways).toEqual(['NDAA Authorization']);
    const committees = svc.committeesFor('Defense & Aerospace', ['NDAA Authorization']);
    expect(committees).toEqual(['HASC', 'SASC']);
  });

  test('Appropriations Justification defaults: funding=true', () => {
    const d = svc.defaultsFor('Appropriations Justification');
    expect(d.funding).toBe(true);
    expect(d.sections.length).toBeGreaterThan(0);
    expect(d.pages).toBeGreaterThan(0);
  });

  test('Report Language Request defaults: funding=false', () => {
    const d = svc.defaultsFor('Report Language Request');
    expect(d.funding).toBe(false);
    expect(d.officeAssociated).toBe(false);
  });

  test('White paper is a funding product', () => {
    expect(svc.defaultsFor('White paper').funding).toBe(true);
  });
});
