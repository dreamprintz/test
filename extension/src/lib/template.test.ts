import { describe, expect, it } from 'vitest';
import { characterCount, contactContext, extractPlaceholders, renderTemplate, toFieldKey, unknownPlaceholders } from './template';

const body = 'Hello {{name}},\n\nYour registration for {{course}} has been received.\n\nYour registration number is {{registration_no}}.\n\nThank you!';

describe('template rendering', () => {
  it('fills placeholders from contact fields', () => {
    const ctx = contactContext({ name: 'Asha Rao', phone: '+919876543210', email: '', fields: { course: 'Data Science', registration_no: 'REG-001' } });
    const r = renderTemplate(body, ctx);
    expect(r.text).toBe('Hello Asha Rao,\n\nYour registration for Data Science has been received.\n\nYour registration number is REG-001.\n\nThank you!');
    expect(r.missing).toEqual([]);
  });
  it('reports missing values and leaves the placeholder visible', () => {
    const r = renderTemplate('Hi {{name}}, course {{course}}', { name: 'A', course: '  ' });
    expect(r.missing).toEqual(['course']);
    expect(r.text).toBe('Hi A, course {{course}}');
  });
  it('supports fallbacks, case-insensitive keys and spacing', () => {
    const r = renderTemplate('Hi {{ Name | there }} 👋', { name: '' });
    expect(r.text).toBe('Hi there 👋');
    expect(r.usedFallback).toEqual(['name']);
    expect(r.missing).toEqual([]);
  });
  it('derives first_name', () => {
    expect(contactContext({ name: 'Ravi Kumar', phone: '', email: '', fields: {} }).first_name).toBe('Ravi');
  });
  it('extracts unique placeholders and flags unknown ones', () => {
    expect(extractPlaceholders('{{a}} {{A}} {{b|x}}')).toEqual([{ key: 'a' }, { key: 'b', fallback: 'x' }]);
    expect(unknownPlaceholders('{{name}} {{cours}}', ['course'])).toEqual(['cours']);
  });
  it('makes header keys', () => {
    expect(toFieldKey('Registration No.')).toBe('registration_no');
    expect(toFieldKey('  Café Name ')).toBe('cafe_name');
  });
  it('counts emoji as single characters', () => {
    expect(characterCount('Hi 👋🏽')).toBe(4);
  });
});
